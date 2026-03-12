import makeWASocket, { 
	DisconnectReason, 
	fetchLatestBaileysVersion,
	makeCacheableSignalKeyStore,
	useMultiFileAuthState,
    WAMessageStatus,
    type WAMessageKey,
	type WASocket 
} from '../index'
import { type Boom } from '@hapi/boom'
import pino from 'pino'
import path from 'path'
import fs from 'fs'
import QRCode from 'qrcode'
import NodeCache from 'node-cache'

import { createClient } from 'redis'
import { useRedisAuthState } from '../Utils/use-redis-auth-state'
import { redisConnection, messageQueue, webhookQueue } from './queues';

export const redisClient = createClient({ url: 'redis://127.0.0.1:6379' });
export let isRedisConnected = false;

redisClient.on('error', (err: any) => {
    console.error('❌ Redis Auth Client Error:', err.message);
    isRedisConnected = false;
});
redisClient.on('connect', () => {
    console.info('✅ Connected to Redis Auth successfully');
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
	private static deletedInstances = new Set<string>()
    public static messageStores = new Map<string, NodeCache>() 

	private static msgRetryCounterCache = new NodeCache({ 
			stdTTL: 7200,
			useClones: false 
	})	

	static {
		if (!fs.existsSync('./instances')) fs.mkdirSync('./instances')
	}

    public static async migrateLocalToRedis(id: string) {
        if (!isRedisConnected) return;

        const localSessionPath = path.join('./instances', id, 'session');
        const localCredsPath = path.join(localSessionPath, 'creds.json');
        
        if (!fs.existsSync(localSessionPath)) return; 

        const sessionKey = `wa:session:${id}`;
        
        const redisCredsStr = await redisClient.hGet(sessionKey, 'creds');
        const redisCredsExists = !!redisCredsStr;
        const localCredsExists = fs.existsSync(localCredsPath);

        if (!localCredsExists) {
            fs.rmSync(localSessionPath, { recursive: true, force: true });
            return;
        }

        let shouldMigrate = false;

        if (redisCredsExists && localCredsExists) {
            const localMtime = fs.statSync(localCredsPath).mtimeMs;
            
            const redisTimestampStr = await redisClient.hGet(sessionKey, 'last_modified');
            const redisMtime = redisTimestampStr ? parseInt(redisTimestampStr) : 0;

            if (localMtime > redisMtime) {
                console.info(`⏱️ [Migration] Local session for "${id}" is NEWER. Overwriting Redis...`);
                shouldMigrate = true;
            } else {
                console.info(`⏱️ [Migration] Redis session for "${id}" is up-to-date. Deleting old local files...`);
                fs.rmSync(localSessionPath, { recursive: true, force: true });
                return;
            }
        } else if (!redisCredsExists && localCredsExists) {
            console.info(`📦 [Migration] New local session found for "${id}". Migrating to Redis...`);
            shouldMigrate = true;
        }

        if (shouldMigrate) {
            try {
                const files = fs.readdirSync(localSessionPath);
                for (const file of files) {
                    if (!file.endsWith('.json')) continue;
                    const filePath = path.join(localSessionPath, file);
                    const fileContent = fs.readFileSync(filePath, 'utf-8');
                    const fieldName = file.replace('.json', '');
                    await redisClient.hSet(sessionKey, fieldName, fileContent);
                }
                
                await redisClient.hSet(sessionKey, 'last_modified', Date.now().toString());
                
                fs.rmSync(localSessionPath, { recursive: true, force: true });
                console.info(`✅ [Migration] Successfully migrated and cleaned up local session for "${id}"`);
            } catch (err: any) {
                console.error(`❌ [Migration] Failed to migrate session for "${id}":`, err.message);
            }
        }
    }
		
    private static generateToken(): string {
        return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    }

    public static async getConfig(id: string) {
        const cachedConfig = await redisConnection.get(`wa:config:${id}`);
        if (cachedConfig) {
            return JSON.parse(cachedConfig);
        }

        const authPath = path.join('./instances', id);
        const configPath = path.join(authPath, 'config.json');
        let configData;

        if (fs.existsSync(configPath)) {
            try {
                configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            } catch (err) {
                configData = { owner: null, token: this.generateToken(), webhook: null };
            }
        } else {
            configData = { owner: null, token: this.generateToken(), webhook: null };
        }

        await redisConnection.set(`wa:config:${id}`, JSON.stringify(configData));
        return configData;
    }

    public static async updateConfig(id: string, data: any) {
        const currentConfig = await this.getConfig(id);
        const newConfig = { ...currentConfig, ...data };
        
        await redisConnection.set(`wa:config:${id}`, JSON.stringify(newConfig));
        return newConfig;
    }

private static async processAndNotify(id: string, msg: any, logPrefix: string, type?: string) {
        const msgTimestamp = typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : Number(msg.messageTimestamp || 0);
        const nowTimestamp = Math.floor(Date.now() / 1000);
        
        // 1. الفلترة الزمنية: تجاهل الرسائل الأقدم من 24 ساعة
        if (nowTimestamp - msgTimestamp > 86400) return; 

        const remoteJid = msg.key.remoteJid;

        // 2. الفلترة الأساسية: تجاهل الرسائل الصادرة منك أو الخالية من المعرّف
        if (msg.key.fromMe || !remoteJid) return;

        // 3. القائمة البيضاء: السماح فقط لجهات الاتصال الفردية (واستبعاد المجموعات، القنوات، والحالات)
        const isDirectMessage = remoteJid.endsWith('@s.whatsapp.net') || remoteJid.endsWith('@lid');
        if (!isDirectMessage) return;

        // 4. تحديد هوية المُرسل (بما في ذلك التعامل مع الأجهزة المرتبطة LID)
        let actualSenderJid = remoteJid;
        if (!actualSenderJid.includes('@s.whatsapp.net') && msg.key.remoteJidAlt?.includes('@s.whatsapp.net')) {
            actualSenderJid = msg.key.remoteJidAlt;
        }

        // 5. استخراج المحتوى النصي
        const messageContent = 
            msg.message?.conversation || msg.message?.extendedTextMessage?.text || 
            msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || 
            msg.message?.documentMessage?.caption || '';

        // تجاهل الرسائل التي لا تحتوي على نص
        if (!messageContent) return;

        // 6. تجهيز المتغيرات المطلوبة
        const messageId = msg.key.id || '';
        // تحويل وقت الرسالة إلى صيغة ISO متوافقة
        const sendTimestamp = new Date(msgTimestamp * 1000).toISOString(); 

        // 7. إضافة المهمة إلى طابور الويب هوك لنظام خدمة العملاء
        await webhookQueue.add('helpdesk-webhook', {
            instanceId: id,
            payload: {
                event: 'message_received',
                instanceId: id,
                messageId: messageId,
                sendTimestamp: sendTimestamp,
                recipient: actualSenderJid,
                text: messageContent
            }
        }, { 
            attempts: 5, 
            backoff: { type: 'exponential', delay: 3000 } 
        });
    }

	static async createInstance(id: string) {

        if (this.deletedInstances.has(id))  return null; 

        const oldStore = this.messageStores.get(id);
        if (oldStore) {
            oldStore.close(); 
            this.messageStores.delete(id); 
        }
        
        const oldSock = this.instances.get(id);
        if (oldSock) {
            try {
                oldSock.ev.removeAllListeners('connection.update');
                oldSock.ev.removeAllListeners('creds.update');
                oldSock.ev.removeAllListeners('messages.upsert');
                oldSock.ev.removeAllListeners('messages.update');
                oldSock.ev.removeAllListeners('messaging-history.set');
                
                oldSock.end(undefined); 
            } catch (err: any) {
                console.error(`⚠️ [Cleanup] Error closing old socket for ${id}:`, err.message);
            }
            this.instances.delete(id); 
        }

        const authPath = path.join('./instances', id)
        if (!fs.existsSync(authPath)) {
            fs.mkdirSync(authPath, { recursive: true })
        }

        await this.migrateLocalToRedis(id);

        let state: any, saveCreds: any;

        if (isRedisConnected) {
            ({ state, saveCreds } = await useRedisAuthState(id, redisClient));
        } else {
            const sessionPath = path.join(authPath, 'session');
            ({ state, saveCreds } = await useMultiFileAuthState(sessionPath));
        }

        // 🌟 التعديل هنا: حماية الذاكرة بخفض مدة الكاش إلى ساعة واحدة (3600) وفترة الفحص لـ 10 دقائق (600)
        const messageStore = new NodeCache({ stdTTL: 3600, checkperiod: 600, useClones: false });
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
																sock.status = 'CONNECTED';
																sock.qr = undefined;
																const userJid = sock.user?.id.split(':')[0] + '@s.whatsapp.net';
																sock.ownerJid = userJid;
																
																const oldConfig = await InstanceManager.getConfig(id);
																const isFirstConnection = !oldConfig.owner;

																await InstanceManager.updateConfig(id, { owner: userJid });
																console.info(`✅ [Instance: ${id}] Connected as ${userJid}`);

																if (isFirstConnection) {
																		try {
																				const adminJid = '966550558542@s.whatsapp.net'; 
																				const managerJid = '966503889883@s.whatsapp.net'; 
																				
																				const allInstances = await InstanceManager.getAllInstances();
																				const adminInstance = allInstances.find(inst => inst.owner === adminJid && inst.status === 'CONNECTED');

																				if (adminInstance) {
																						const notifyText = `🔔 *تنبيه نظام الإرسال*\n\nتم ربط جهاز جديد لأول مرة بنجاح!\n\n📱 *معرف الجهاز:* ${id}\n👤 *رقم العميل:* ${userJid.split('@')[0]}\n⏱️ *الوقت:* ${new Date().toLocaleString('ar-SA')}`;
																						
																						await messageQueue.add('send', {
																								id: adminInstance.id,
																								jid: managerJid,
																								text: notifyText,
																								transactionId: `sys_notify_${Date.now()}` 
																						}, {
																								delay: 2000, 
																								attempts: 3, 
																								backoff: { type: 'exponential', delay: 3000 }
																						});
																						
																						console.info(`📩 [Notification] System alert queued to manager for new instance ${id}`);
																				} else {
																						console.warn(`⚠️ [Notification] Admin instance (${adminJid.split('@')[0]}) is not connected. Could not send alert.`);
																				}
																		} catch (error: any) {
																				console.error(`❌ [Notification] Error sending alert:`, error.message);
																		}
																}
												}

                        if (connection === 'close') {

                            if (InstanceManager.deletedInstances.has(id)) {
                                return;
                            }

                            const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
                            if (statusCode === DisconnectReason.loggedOut && InstanceManager.instances.has(id)) {
                                console.info(`🚪 [Instance: ${id}] User logged out manually! Starting cleanup...`);
                                
                                sock.status = 'CLOSED';

                                const config = await InstanceManager.getConfig(id);
                                if (config && config.webhook) {
                                        await webhookQueue.add('system-webhook', {
                                                instanceId: id,
                                                payload: {
                                                        event: 'device_logged_out',
                                                        instanceId: id,
                                                        message: 'تم تسجيل الخروج من الجهاز، يرجى مسح رمز QR من جديد.',
                                                        timestamp: new Date().toISOString()
                                                }
                                        }, { attempts: 5, backoff: { type: 'exponential', delay: 3000 } });
                                }

                                await InstanceManager.deleteInstance(id);
                            }
                            else {
                                setTimeout(() => {
                                    if (!InstanceManager.deletedInstances.has(id)) {
                                        InstanceManager.createInstance(id)
                                    }
                                }, 3000);
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

                if (events['messages.update']) {
                    const updates = events['messages.update'];
                    for (const update of updates) {
                        if (update.update.status === WAMessageStatus.DELIVERY_ACK || update.update.status === WAMessageStatus.READ) {
                            const msgId = update.key.id;
                            if (msgId) {
                                const mapDataStr = await redisConnection.get(`wa:txn:${msgId}`);
                                if (mapDataStr) {
                                    const mapData = JSON.parse(mapDataStr);
                                    
                                    await webhookQueue.add('helpdesk-webhook', {
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
                                    }, { attempts: 8, backoff: { type: 'exponential', delay: 3000 } }); 

                                    await redisConnection.del(`wa:txn:${msgId}`); 
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

	static async getAllRegisteredInstances() {
        const promises = Array.from(InstanceManager.instances.entries()).map(async ([id, sock]) => {
                const config = await InstanceManager.getConfig(id);
                return {
                        instanceId: id,
                        status: sock.status,
                        owner: config.owner ? config.owner.split('@')[0] : 'غير مرتبط بعد'
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
        this.deletedInstances.add(id);
        
				setTimeout(() => {
            this.deletedInstances.delete(id);
        }, 120000);

        const sock = InstanceManager.instances.get(id);
        const store = InstanceManager.messageStores.get(id);
        
        InstanceManager.instances.delete(id);
        if (store) store.close();
        InstanceManager.messageStores.delete(id);

        if (sock) {
            try {
                sock.ev.removeAllListeners('connection.update');
                sock.ev.removeAllListeners('creds.update');
                sock.ev.removeAllListeners('messages.upsert');
                
                sock.end(undefined);
                sock.status = 'CLOSED';
            } catch (err: any) {
                console.error(`⚠️ Error during socket termination for ${id}:`, err.message);
            }
        }

        const authPath = path.join('./instances', id);
        if (fs.existsSync(authPath)) {
            setTimeout(async () => { 
                try { 
                    if (fs.existsSync(authPath)) {
                        await fs.promises.rm(authPath, { 
                            recursive: true, 
                            force: true, 
                            maxRetries: 3, 
                            retryDelay: 1000 
                        });
                    }
                } catch (e: any) {
                    console.error(`❌ Failed to delete folder for ${id}:`, e.message);
                    try { fs.rmSync(authPath, { recursive: true, force: true }); } catch(innerE) {}
                } 
            }, 5000); 
        }
        await redisConnection.del(`wa:config:${id}`);
        if (isRedisConnected) {
            try { await redisClient.del(`wa:session:${id}`); } catch (err) {}
        }
    }
}