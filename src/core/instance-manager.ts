import makeWASocket, { 
	DisconnectReason, 
	fetchLatestBaileysVersion,
	makeCacheableSignalKeyStore,
	useMultiFileAuthState,
    WAMessageStatus, // 🌟 [تحديث: استيراد حالات الرسائل]
    type WAMessageKey,
	type WASocket 
} from '../index.js' // أو مسار '@whiskeysockets/baileys' الصحيح لديك
import { type Boom } from '@hapi/boom'
import pino from 'pino'
import path from 'path'
import fs from 'fs'
import QRCode from 'qrcode'
import NodeCache from 'node-cache'

import { createClient } from 'redis'
import { useRedisAuthState } from '../Utils/use-redis-auth-state.ts' // تأكد من المسار

export const redisClient = createClient({
    url: 'redis://127.0.0.1:6379'
});
export let isRedisConnected = false;
redisClient.on('error', (err) => {
    console.error('❌ Redis Client Error:', err.message);
    isRedisConnected = false;
});

redisClient.on('connect', () => {
    console.log('✅ Connected to Redis successfully');
    isRedisConnected = true;
});

redisClient.connect().catch(() => {
    console.log('⚠️ Failed to connect to Redis. Falling back to Local Files.');
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
    
    // 🌟 [تحديث: خريطة لحفظ العمليات المرتبطة بالرسائل لتعقب الاستلام] تحفظ لـ 7 أيام
    public static messageTransactionMap = new NodeCache({ stdTTL: 604800, checkperiod: 3600, useClones: false })
    
	private static msgRetryCounterCache = new NodeCache()
	
	static {
		if (!fs.existsSync('./instances')) fs.mkdirSync('./instances')
	}

    private static generateToken(): string {
        return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    }

    public static getConfig(id: string) {
        const authPath = path.join('./instances', id);
        const configPath = path.join(authPath, 'config.json');

        if (fs.existsSync(configPath)) {
            try {
                return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            } catch (err) {
                console.error(`❌ خطأ في قراءة إعدادات ${id}`);
            }
        }

        const defaultConfig = { owner: null, token: this.generateToken(), webhook: null };
        if (!fs.existsSync(authPath)) {
            fs.mkdirSync(authPath, { recursive: true });
        }
        fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
        
        return defaultConfig;
    }

    public static updateConfig(id: string, data: any) {
        const configPath = path.join('./instances', id, 'config.json');
        const currentConfig = this.getConfig(id);
        const newConfig = { ...currentConfig, ...data };
        
        fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));
        return newConfig;
    }

    // 🌟 [تحديث: دالة الويب هوك مع التكرار التصاعدي]
    public static async triggerWebhookWithRetry(instanceId: string, payload: any) {
        const config = InstanceManager.getConfig(instanceId);
        if (!config.webhook) return;

        let delay = 3000;
        for (let attempt = 1; attempt <= 8; attempt++) { // المحاولة الأساسية + 7 تكرارات
            try {
                const res = await fetch(config.webhook, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (res.ok) {
                    console.log(`✅ [Webhook] Sent successfully for txn: ${payload.transactionId} | Event: ${payload.event}`);
                    return; 
                }
                throw new Error(`HTTP Status: ${res.status}`);
            } catch (err: any) {
                if (attempt > 7) {
                    console.error(`❌ [Webhook] Max retries reached for txn: ${payload.transactionId}`);
                    break;
                }
                console.error(`⚠️ [Webhook] Attempt ${attempt} failed for txn: ${payload.transactionId}: ${err.message}. Retrying in ${delay}ms`);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay += 3000; // زيادة تصاعدية بـ 3 ثواني
            }
        }
    }

    // 🌟 [تحديث: محرك الإرسال في الخلفية مع التكرار]
    public static async scheduleMessageSend(id: string, jid: string, text: string, file: string, fileName: string, transactionId: string) {
        // 1. تأخير عشوائي مبدئي بين 1 و 5 ثواني
        const initialDelay = Math.floor(Math.random() * 4000) + 1000;
        await new Promise(resolve => setTimeout(resolve, initialDelay));

        const sock = InstanceManager.instances.get(id);
        if (!sock) return;

        let success = false;
        let result: any;
        let delay = 3000;

        // 2. محاولة الإرسال مع التكرار عند الفشل
        for (let attempt = 1; attempt <= 8; attempt++) { // المحاولة الأساسية + 7 تكرارات
            try {
                if (file) {
                    result = await sock.sendMessage(jid, {
                        document: Buffer.from(file, 'base64'),
                        mimetype: 'application/pdf',
                        fileName: fileName || 'document.pdf',
                        caption: text
                    });
                } else {
                    result = await sock.sendMessage(jid, { text });
                }
                success = true;
                break; // نجاح العملية، نخرج من الحلقة
            } catch (error: any) {
                if (attempt > 7) {
                    console.error(`❌ [Send] Max retries reached for txn: ${transactionId}`);
                    break;
                }
                console.error(`⚠️ [Send] Attempt ${attempt} failed for txn: ${transactionId}: ${error.message}. Retrying in ${delay}ms`);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay += 3000; // زيادة تصاعدية بـ 3 ثواني
            }
        }

        // 3. في حال النجاح، تخزين البيانات وقدح الويب هوك الأول
        if (success && result?.key?.id) {
            const messageId = result.key.id;
            const sendTimestamp = new Date().toISOString();

            // حفظ البيانات لتعقب الاستلام لاحقاً
            InstanceManager.messageTransactionMap.set(messageId, {
                transactionId,
                sendTimestamp
            });

            // قدح ويب هوك (تم الإرسال)
            this.triggerWebhookWithRetry(id, {
                event: 'message_sent',
                instanceId: id,
                transactionId,
                messageId,
                sendTimestamp,
                deliveryTimestamp: null,
                recipient: jid
            });
        }
    }

    private static async processAndNotify(id: string, msg: any, logPrefix: string, type?: string) {
        // فلتر زمني: حماية من الرسائل القديمة (أكثر من 24 ساعة)
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
                msg.message?.conversation || 
                msg.message?.extendedTextMessage?.text || 
                msg.message?.imageMessage?.caption || 
                msg.message?.videoMessage?.caption || 
                msg.message?.documentMessage?.caption || 
                '';

        if (!messageContent) return;

        const now: Date = new Date();
        console.log(`\n📩 ${logPrefix} [Instance: ${id}] النوع ${type}`);
        if (isGroup) {
                console.log(`👥 من مجموعة: ${groupId}`);
        }
        console.log(`📱 رقم المرسل: ${senderNumber}`);
        console.log(`💬 النص: ${messageContent}`);
        console.log(`الوقت: ${now.toLocaleTimeString()}\n`);

        const config = InstanceManager.getConfig(id);
        if (config.webhook) {
            this.triggerWebhookWithRetry(id, {
                event: 'message_received',
                instanceId: id,
                isGroup,
                groupId,
                sender: senderNumber,
                message: messageContent,
                timestamp: now.toISOString()
            });
        }
    }	

	static async createInstance(id: string) {
			const authPath = path.join('./instances', id)
            
            if (!fs.existsSync(authPath)) {
                fs.mkdirSync(authPath, { recursive: true })
            }

			let state: any, saveCreds: any;

            if (isRedisConnected) {
                console.log(`🔄 [Instance: ${id}] Using Redis Auth State`);
                ({ state, saveCreds } = await useRedisAuthState(id, redisClient));
            } else {
                console.log(`📁 [Instance: ${id}] Using Local File Auth State`);
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
									
                                    InstanceManager.updateConfig(id, { owner: userJid });
									
									const now: Date = new Date();
                                    console.log(`✅ [Instance: ${id}] Connected as ${userJid} Ver. ${version} At ${now.toLocaleTimeString()}`);
							}

							if (connection === 'close') {
							    console.log(`⛔ [Instance: ${id}] Closed!`);

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
                                        if (msg.key.id && msg.message) {
                                            messageStore.set(msg.key.id, msg.message);
                                        }
                                        await InstanceManager.processAndNotify(id, msg, 'رسالة جديدة', type);
                                    }
                            }
                    }

                    // 🌟 [تحديث: مراقبة حالة استلام الرسالة المرسلة - Delivery Receipt]
                    if (events['messages.update']) {
                        const updates = events['messages.update'];
                        for (const update of updates) {
                            // التحقق إذا كانت الحالة: تم الاستلام في الجهاز (DELIVERY_ACK) أو مقروءة (READ)
                            if (update.update.status === WAMessageStatus.DELIVERY_ACK || update.update.status === WAMessageStatus.READ) {
                                const msgId = update.key.id;
                                if (msgId) {
                                    const mapData = InstanceManager.messageTransactionMap.get<{transactionId: string, sendTimestamp: string}>(msgId);
                                    if (mapData) {
                                        InstanceManager.triggerWebhookWithRetry(id, {
                                            event: 'message_delivered',
                                            instanceId: id,
                                            transactionId: mapData.transactionId,
                                            messageId: msgId,
                                            sendTimestamp: mapData.sendTimestamp,
                                            deliveryTimestamp: new Date().toISOString(),
                                            recipient: update.key.remoteJid
                                        });
                                        // يمكن إزالة العنصر من الذاكرة إذا كنا نهتم بأول تأكيد استلام فقط لتخفيف الحمل
                                        InstanceManager.messageTransactionMap.del(msgId);
                                    }
                                }
                            }
                        }
                    }

					if (events['messaging-history.set']) {
							const { messages } = events['messaging-history.set'];
							console.log(`\n🔄 [Instance: ${id}] بدء مزامنة السجل (History Sync) - تم استلام ${messages.length} رسالة`);

							for (const msg of messages) {
                                if (msg.key.id && msg.message) {
                                    messageStore.set(msg.key.id, msg.message); 
                                }
                                await InstanceManager.processAndNotify(id, msg, 'رسالة متأخرة/مزامنة');
							}
					}

					if (events['creds.update']) {
							await saveCreds()
					}
			})

			InstanceManager.instances.set(id, sock)
			return sock
	}

	static getAllInstances() {
		const list: any[] = [];
		InstanceManager.instances.forEach((sock, id) => {
            const config = InstanceManager.getConfig(id);
			list.push({
				id,
				status: sock.status,
				owner: config.owner,
                token: config.token,
                webhook: config.webhook,
				qr: sock.qr || null
			});
		});
		return list;
	}

	static getInstance(id: string) {
		const sock = InstanceManager.instances.get(id)
		if (!sock) return null
        const config = InstanceManager.getConfig(id);
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
        if (store) {
            store.close();
        }
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
            setTimeout(() => {
                try { fs.rmSync(authPath, { recursive: true, force: true }); } catch (e) {}
            }, 2000);
        }

        if (isRedisConnected) {
            try {
                await redisClient.del(`wa:session:${id}`);
                console.log(`🗑️ [Instance: ${id}] Removed securely from Redis.`);
            } catch (err) {
                console.error(`[Redis Cleanup Error] Failed to delete session: ${id}`, err);
            }
        }
    }
}