import makeWASocket, { 
	DisconnectReason, 
	fetchLatestBaileysVersion,
	makeCacheableSignalKeyStore,
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

// إنشاء والاتصال بـ Redis
export const redisClient = createClient({
    url: 'redis://127.0.0.1:6379'
});
redisClient.on('error', (err) => console.error('❌ Redis Client Error:', err));
redisClient.on('connect', () => console.log('✅ Connected to Redis successfully'));
redisClient.connect().catch(console.error);

interface ExtendedSocket extends WASocket {
	qr?: string
	status?: 'WAITING' | 'CONNECTED' | 'CLOSED'
	ownerJid?: string
}

export class InstanceManager {
	public static instances = new Map<string, ExtendedSocket>()
	private static msgRetryCounterCache = new NodeCache()
	
	static {
		if (!fs.existsSync('./instances')) fs.mkdirSync('./instances')
	}

    // --- دوال إدارة الـ Config الجديدة ---
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
    // ------------------------------------

	static async createInstance(id: string) {
			const authPath = path.join('./instances', id)
            
            if (!fs.existsSync(authPath)) {
                fs.mkdirSync(authPath, { recursive: true })
            }

			const { state, saveCreds } = await useRedisAuthState(id, redisClient)
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
									
                                    // حفظ الإعدادات في config.json
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
							
							if (type === 'notify') {
									for (const msg of messages) {
											if (!msg.key.fromMe && msg.key.remoteJid && msg.key.remoteJid !== 'status@broadcast') {
													
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

													if (messageContent) {
															const now: Date = new Date();

															console.log(`\n📩 رسالة جديدة [Instance: ${id}]`)
															if (isGroup) {
																	console.log(`👥 من مجموعة: ${groupId}`)
															}
															console.log(`📱 رقم المرسل: ${senderNumber}`)
															console.log(`💬 النص: ${messageContent}`)
															console.log(`الوقت: ${now.toLocaleTimeString()}\n`)

                                                            // إرسال البيانات إلى الـ Webhook
                                                            const config = InstanceManager.getConfig(id);
                                                            if (config.webhook) {
                                                                try {
                                                                    fetch(config.webhook, {
                                                                        method: 'POST',
                                                                        headers: { 'Content-Type': 'application/json' },
                                                                        body: JSON.stringify({
                                                                            instanceId: id,
                                                                            isGroup,
                                                                            groupId,
                                                                            sender: senderNumber,
                                                                            message: messageContent,
                                                                            timestamp: now.toISOString()
                                                                        })
                                                                    }).catch(err => console.error(`❌ خطأ في إرسال الويب هوك للنسخة ${id}:`, err.message));
                                                                } catch (e) {}
                                                            }
													}
											}
									}
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

        try {
            await redisClient.del(`wa:session:${id}`);
            console.log(`🗑️ [Instance: ${id}] Removed securely from Redis.`);
        } catch (err) {
            console.error(`[Redis Cleanup Error] Failed to delete session: ${id}`, err);
        }
    }
}