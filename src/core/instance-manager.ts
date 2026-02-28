import makeWASocket, { 
	DisconnectReason, 
	fetchLatestBaileysVersion,
	makeCacheableSignalKeyStore,
	useMultiFileAuthState,
    WAMessageStatus,
    type WAMessageKey,
	type WASocket 
} from '../index.js'
import { type Boom } from '@hapi/boom'
import pino from 'pino'
import path from 'path'
import fs from 'fs'
import QRCode from 'qrcode'
import NodeCache from 'node-cache'

import { createClient } from 'redis'
import { useRedisAuthState } from '../Utils/use-redis-auth-state.ts'

// استدعاء نظام الطوابير الجديد (Redis + BullMQ)
import { redisConnection, messageQueue, webhookQueue } from './queues.js';

// عميل Redis الكلاسيكي (مخصص فقط لحفظ الجلسات/Auth State لكي لا نكسر الكود القديم)
export const redisClient = createClient({ url: 'redis://127.0.0.1:6379' });
export let isRedisConnected = false;

redisClient.on('error', (err) => {
    console.error('❌ Redis Auth Client Error:', err.message);
    isRedisConnected = false;
});
redisClient.on('connect', () => {
    console.log('✅ Connected to Redis Auth successfully');
    isRedisConnected = true;
});
redisClient.connect().catch(() => {
    console.log('⚠️ Failed to connect to Redis Auth. Falling back to Local Files.');
    isRedisConnected = false;
});

interface ExtendedSocket extends WASocket {
	qr?: string
	status?: 'WAITING' | 'CONNECTED' | 'CLOSED'
	ownerJid?: string
}

export class InstanceManager {
	public static instances = new Map<string, ExtendedSocket>()
    public static messageStores = new Map<string, NodeCache>() 
	private static msgRetryCounterCache = new NodeCache()
	
	static {
		if (!fs.existsSync('./instances')) fs.mkdirSync('./instances')
	}

    private static generateToken(): string {
        return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    }

    // 🌟 [تحديث: جلب الإعدادات من Redis بصورة غير متزامنة مع هجرة تلقائية للملفات]
    public static async getConfig(id: string) {
        // 1. محاولة القراءة من Redis أولاً (فائق السرعة ولا يوقف السيرفر)
        const cachedConfig = await redisConnection.get(`wa:config:${id}`);
        if (cachedConfig) {
            return JSON.parse(cachedConfig);
        }

        // 2. هجرة البيانات (Migration): إذا لم يكن في Redis، اقرأ من الملف المحلي (لمرة واحدة فقط)
        const authPath = path.join('./instances', id);
        const configPath = path.join(authPath, 'config.json');
        let configData;

        if (fs.existsSync(configPath)) {
            try {
                configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            } catch (err) {
                console.error(`❌ خطأ في قراءة إعدادات ${id}`);
                configData = { owner: null, token: this.generateToken(), webhook: null };
            }
        } else {
            configData = { owner: null, token: this.generateToken(), webhook: null };
            if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });
        }

        // 3. حفظ الإعدادات في Redis للاستخدام المستقبلي
        await redisConnection.set(`wa:config:${id}`, JSON.stringify(configData));
        return configData;
    }

    // 🌟 [تحديث: تحديث الإعدادات وحفظها في Redis]
    public static async updateConfig(id: string, data: any) {
        const currentConfig = await this.getConfig(id);
        const newConfig = { ...currentConfig, ...data };
        
        await redisConnection.set(`wa:config:${id}`, JSON.stringify(newConfig));
        return newConfig;
    }

    private static async processAndNotify(id: string, msg: any, logPrefix: string, type?: string) {
        const msgTimestamp = typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : Number(msg.messageTimestamp || 0);
        const nowTimestamp = Math.floor(Date.now() / 1000);
        if (nowTimestamp - msgTimestamp > 86400) return; 

        if (msg.key.fromMe || !msg.key.remoteJid || msg.key.remoteJid === 'status@broadcast') return;

        const isGroup = msg.key.remoteJid.endsWith('@g.us');
        const groupId = isGroup ? msg.key.remoteJid.split('@')[0] : null;
        
        let actualSenderJid = '';
        if (isGroup) {
                actualSenderJid = msg.key.participant || '';
                if (msg.key.addressingMode === 'lid' && msg.key.participantAlt?.includes('@s.whatsapp.net')) {
                        actualSenderJid = msg.key.participantAlt;
                } else if (!actualSenderJid.includes('@s.whatsapp.net') && msg.key.participantAlt?.includes('@s.whatsapp.net')) {
                        actualSenderJid = msg.key.participantAlt;
                }
        } else {
                actualSenderJid = msg.key.remoteJid;
                if (msg.key.addressingMode === 'lid' && msg.key.remoteJidAlt?.includes('@s.whatsapp.net')) {
                        actualSenderJid = msg.key.remoteJidAlt;
                } else if (!actualSenderJid.includes('@s.whatsapp.net') && msg.key.remoteJidAlt?.includes('@s.whatsapp.net')) {
                        actualSenderJid = msg.key.remoteJidAlt;
                }
        }

        const senderNumber = actualSenderJid.split('@')[0];
        const messageContent = 
                msg.message?.conversation || msg.message?.extendedTextMessage?.text || 
                msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || 
                msg.message?.documentMessage?.caption || '';

        if (!messageContent) return;

        const now: Date = new Date();
        console.log(`\n📩 ${logPrefix} [Instance: ${id}] النوع ${type}`);
        console.log(`📱 رقم المرسل: ${senderNumber}`);
        console.log(`💬 النص: ${messageContent}`);

        // 🌟 [تحديث: إضافة مهمة إرسال ويب هوك للطابور بدلاً من الإرسال المباشر]
        //const config = await InstanceManager.getConfig(id);
        //if (config.webhook) {
        //    await webhookQueue.add('receive-webhook', {
        //        instanceId: id,
        //        payload: {
        //            event: 'message_received',
        //            instanceId: id,
        //            isGroup,
        //            groupId,
        //            sender: senderNumber,
        //            message: messageContent,
        //            timestamp: now.toISOString()
        //        }
        //    }, { attempts: 8, backoff: { type: 'exponential', delay: 3000 }, removeOnComplete: { count: 1000 }, // 🌟 الاحتفاظ بالسجل للمراقبة
        //removeOnFail: { count: 1000 } });
        //}
    }	

	static async createInstance(id: string) {
			const authPath = path.join('./instances', id)
            if (!fs.existsSync(authPath)) {
                fs.mkdirSync(authPath, { recursive: true })
            }

			let state: any, saveCreds: any;

            if (isRedisConnected) {
                ({ state, saveCreds } = await useRedisAuthState(id, redisClient));
            } else {
                const sessionPath = path.join(authPath, 'session');
                ({ state, saveCreds } = await useMultiFileAuthState(sessionPath));
            }

            const messageStore = new NodeCache({ stdTTL: 86400, checkperiod: 3600, useClones: false });
            this.messageStores.set(id, messageStore);
			const { version } = await fetchLatestBaileysVersion()

			const sock = makeWASocket({
					version,
					logger: pino({ level: 'error' }),
					auth: {
							creds: state.creds,
							keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'error' })),
					},
					msgRetryCounterCache: this.msgRetryCounterCache,
					printQRInTerminal: false,
					browser: ['Ubuntu', 'Chrome', '110.0.5563.147'],
					generateHighQualityLinkPreview: true,
					markOnlineOnConnect: true,
                    
					getMessage: async (key: WAMessageKey) => {
                        if (key.id) {
                            const msg = messageStore.get<any>(key.id);
                            if (msg) return msg;
                        }
                        return { conversation: '' };
					}
			}) as ExtendedSocket

			sock.ev.process(async (events) => {
					if (events['connection.update']) {
							const update = events['connection.update']
							const { connection, lastDisconnect, qr } = update
							
							if (qr) sock.qr = await QRCode.toDataURL(qr)
							
							if (connection === 'open') {
									sock.status = 'CONNECTED'
									sock.qr = undefined
									const userJid = sock.user?.id.split(':')[0] + '@s.whatsapp.net';
									sock.ownerJid = userJid;
									
                                    await InstanceManager.updateConfig(id, { owner: userJid });
                                    console.log(`✅ [Instance: ${id}] Connected as ${userJid}`);
							}

							if (connection === 'close') {
								const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
								if (statusCode !== DisconnectReason.loggedOut && InstanceManager.instances.has(id)) {
									setTimeout(() => InstanceManager.createInstance(id), 3000);
								}
							}
					}

                    if (events['messages.upsert']) {
                            const { messages, type } = events['messages.upsert']
                            if (type === 'notify' || type === 'append') {
                                    for (const msg of messages) {
                                        if (msg.key.id && msg.message) messageStore.set(msg.key.id, msg.message);
                                        await InstanceManager.processAndNotify(id, msg, 'رسالة جديدة', type);
                                    }
                            }
                    }

                    // 🌟 [تحديث: التحقق من الوصول عبر Redis وإضافة ويب هوك للطابور]
                    if (events['messages.update']) {
                        const updates = events['messages.update'];
                        for (const update of updates) {
                            if (update.update.status === WAMessageStatus.DELIVERY_ACK || update.update.status === WAMessageStatus.READ) {
                                const msgId = update.key.id;
                                if (msgId) {
                                    const mapDataStr = await redisConnection.get(`wa:txn:${msgId}`);
                                    if (mapDataStr) {
                                        const mapData = JSON.parse(mapDataStr);
                                        
                                        await webhookQueue.add('send-webhook', {
                                            instanceId: id,
                                            payload: {
                                                event: 'message_delivered',
                                                instanceId: id,
                                                transactionId: mapData.transactionId,
                                                messageId: msgId,
                                                sendTimestamp: mapData.sendTimestamp,
                                                deliveryTimestamp: new Date().toISOString(),
                                                recipient: update.key.remoteJid
                                            }
                                        }, { attempts: 8, backoff: { type: 'exponential', delay: 3000 }, removeOnComplete: { count: 1000 }, // 🌟 الاحتفاظ بالسجل للمراقبة
        removeOnFail: { count: 1000 } });

                                        await redisConnection.del(`wa:txn:${msgId}`); // تنظيف العملية
                                    }
                                }
                            }
                        }
                    }

					if (events['messaging-history.set']) {
							const { messages } = events['messaging-history.set'];
							for (const msg of messages) {
                                if (msg.key.id && msg.message) messageStore.set(msg.key.id, msg.message); 
                                await InstanceManager.processAndNotify(id, msg, 'رسالة مزامنة');
							}
					}

					if (events['creds.update']) await saveCreds();
			})

			InstanceManager.instances.set(id, sock)
			return sock
	}

    // 🌟 [تحديث: تحويل دالة الجلب لتكون غير متزامنة وتتعامل مع وعود Redis]
	static async getAllInstances() {
        const promises = Array.from(InstanceManager.instances.entries()).map(async ([id, sock]) => {
            const config = await InstanceManager.getConfig(id);
            return {
                id,
                status: sock.status,
                owner: config.owner,
                token: config.token,
                webhook: config.webhook,
                qr: sock.qr || null
            };
        });
        return Promise.all(promises);
	}

	static async getInstance(id: string) {
		const sock = InstanceManager.instances.get(id)
		if (!sock) return null
        const config = await InstanceManager.getConfig(id);
		return {
			id,
			status: sock.status,
			owner: config.owner,
            token: config.token,
            webhook: config.webhook,
			qr: sock.qr || null
		}
	}

    static async deleteInstance(id: string) {
        const sock = InstanceManager.instances.get(id);
        const store = InstanceManager.messageStores.get(id);
        if (store) store.close();
        InstanceManager.messageStores.delete(id); 
        InstanceManager.instances.delete(id);

        if (sock) {
            try {
                sock.ev.removeAllListeners('connection.update');
                sock.ev.removeAllListeners('creds.update');
                sock.end(undefined);
            } catch (err) {}
        }

        const authPath = path.join('./instances', id);
        if (fs.existsSync(authPath)) {
            setTimeout(() => { try { fs.rmSync(authPath, { recursive: true, force: true }); } catch (e) {} }, 2000);
        }

        await redisConnection.del(`wa:config:${id}`); // إزالة الإعدادات من كاش Redis

        if (isRedisConnected) {
            try { await redisClient.del(`wa:session:${id}`); } catch (err) {}
        }
    }
}