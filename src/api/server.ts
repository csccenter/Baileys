import Fastify from 'fastify'
import cors from '@fastify/cors'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { InstanceManager } from '../core/instance-manager.js'
import { nanoid } from 'nanoid'
import fs from 'fs'
import path from 'path'

import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter'
import { FastifyAdapter } from '@bull-board/fastify'
import { messageQueue, webhookQueue, redisConnection } from '../core/queues.js'
import fastifyBasicAuth from '@fastify/basic-auth'
import fastifyStatic from '@fastify/static'

import multipart from '@fastify/multipart'

async function bootstrap() {

	const INSTANCE_SECRET_KEY = 'ubovv1qwz0msltpuiniybo'
	
	const fastify = Fastify({ 
		logger: { level: 'error' },
		ajv: { customOptions: { strict: false, allErrors: true } } 
	})

	await fastify.register(multipart, {
    limits: {
        fileSize: 20 * 1024 * 1024 // حد أقصى 20 ميجابايت للملف
    }
	});

	await fastify.register(cors, { 
			origin: true,
			methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
			allowedHeaders: ['Content-Type', 'Authorization'],
			credentials: true
	})

	await fastify.register(swagger, {
		openapi: {
			openapi: '3.1.0', 
			info: { 
					title: 'واجهة تطبيقات الارسال من خلال واتس اب', 
					version: '1.0.0',
					description: 'دليل استخدام واجهة برمجة تطبيقات واتساب. يمكنك إرسال الرسائل من خلال الـ API، واستقبال التحديثات عبر الـ Webhook.'
			},
			components: {
				securitySchemes: {
					bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }
				}
			},
            webhooks: {
                'WhatsAppEvents': {
                        post: {
                                summary: 'أحداث واتساب (Webhook Payload)',
                                description: 'نقطة النهاية (Endpoint) الخاصة بك يجب أن تكون جاهزة لاستقبال طلبات `POST` تحتوي على هذا الـ JSON.',
                                requestBody: {
                                        content: {
                                                'application/json': {
                                                        schema: {
                                                                type: 'object',
                                                                properties: {
                                                                        event: { 
                                                                                type: 'string', 
                                                                                enum: ['message_received', 'message_sent', 'message_delivered', 'device_logged_out'],
                                                                                description: `**نوع الحدث الوارد.** توقع إحدى القيم التالية:
* \`message_received\`: يتم إرساله عندما يستقبل رقمك رسالة جديدة.
* \`message_sent\`: يتم إرساله لتأكيد خروج رسالتك من خوادمنا إلى شبكة واتساب.
* \`message_delivered\`: يتم إرساله عندما يصل إشعار استلام (علامتي صح) من هاتف المستلم.
* \`device_logged_out\`: تنبيه أمني وحرج يتم إرساله إذا قام المستخدم بتسجيل الخروج من تطبيق واتساب في هاتفه.`
                                                                        },
                                                                        instanceId: { 
                                                                                type: 'string', 
                                                                                description: 'المعرف الفريد للجهاز (Instance ID) الذي صدر منه هذا الحدث.' 
                                                                        },
                                                                        payload: { 
                                                                                type: 'object', 
                                                                                description: `**تفاصيل الحدث.** يختلف محتوى هذا الكائن بناءً على نوع الحدث (event).`
                                                                        }
                                                                }
                                                        }
                                                }
                                        }
                                },
                                responses: {
                                        '200': { description: 'يجب أن يرد خادمك برمز `200 OK` لتأكيد استلام الحدث بنجاح.' }
                                }
                        }
                }
            }
		}
	})

	await fastify.register(swaggerUi, { routePrefix: '/docs' })

	await fastify.register(fastifyBasicAuth, {
			validate: async function (username, password, req, reply) {
					if (username !== 'admin' || password !== 'nimda@2030') {
							return new Error('Unauthorized'); // رفض الدخول إذا كانت البيانات خاطئة
					}
			},
			authenticate: true
	});

	const serverAdapter = new FastifyAdapter();
	createBullBoard({
			queues: [
					new BullMQAdapter(messageQueue),
					new BullMQAdapter(webhookQueue)
			],
			serverAdapter,
	});
	serverAdapter.setBasePath('/admin/queues');

	fastify.register(async function (protectedScope) {
			protectedScope.addHook('preHandler', fastify.basicAuth);
			protectedScope.register(serverAdapter.registerPlugin(), { prefix: '/admin/queues' });
	});

	fastify.addHook('preHandler', async (request, reply) => {
			const url = request.url;
			const { id } = request.params as { id: string };
			const method = request.method;

			const isPublic = url.startsWith('/docs') || 
												url.startsWith('/admin/queues') ||
												url.startsWith('/auth/request-link') || 
												url.startsWith('/instances/verify') ||
												(url === '/instances' && method === 'POST') ||
												url.includes('/config');

			if (isPublic) return;

			if (id) {
					const instance = await InstanceManager.getInstance(id);

					if (method === 'DELETE' && (!instance || instance.status !== 'CONNECTED')) {
							return; 
					}

					const config = await InstanceManager.getConfig(id);
					const savedToken = config.token;
					const authHeader = request.headers['authorization'];
					const providedToken = authHeader?.replace('Bearer ', '');

					if (!providedToken || providedToken !== savedToken) {
							return reply.status(401).send({ 
									error: 'Unauthorized', 
									message: 'هذا الجهاز مرتبط بنظام نشط، يجب تقديم التوكين لتنفيذ العملية.' 
							});
					}
			}
	});

const frontendPath = path.join(process.cwd(), 'public');
	
	if (fs.existsSync(frontendPath)) {
			await fastify.register(fastifyStatic, {
					root: frontendPath,
					prefix: '/', 
					wildcard: false 
			});

			fastify.setNotFoundHandler((request, reply) => {
					if (request.method === 'GET' && request.headers.accept?.includes('text/html')) {
							reply.sendFile('index.html');
					} else {
							reply.status(404).send({ error: 'Not Found', message: 'المسار غير موجود' });
					}
			});
			
			console.info('✅ Frontend successfully integrated with Backend.');
	} else {
			console.log('⚠️ Frontend "dist" folder not found. Serving API only.');
	}

	fastify.post('/auth/request-link', {
			schema: {
					hide: true,
					tags: ['Authentication'],
					body: {
							type: 'object',
							required: ['phoneNumber'],
							properties: { phoneNumber: { type: 'string' } }
					}
			}
	}, async (request: any) => {
			const { phoneNumber } = request.body;
			
			const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
			const jid = `${cleanNumber}@s.whatsapp.net`;
			
			const instances = await InstanceManager.getAllInstances();
			const found = instances.find(inst => inst.owner === jid);

			if (!found) {
					return { action: 'NOT_FOUND' };
			}

			const sock = (InstanceManager as any).instances.get(found.id);
			if (found.status === 'CONNECTED' && sock) {
					const magicToken = nanoid(32);

					await redisConnection.setex(`wa:magic:${magicToken}`, 600, found.id);

					const managementUrl = `https://api.mersaliy.com/?manage=${found.id}&magic=${magicToken}`;
					
					const transactionId = `sys_magic_${nanoid(10)}`; 
					
					await messageQueue.add('send', { 
							id: found.id, 
							jid: jid, 
							text: `🔐 رابط الإدارة الخاص بك:\n${managementUrl}`, 
							transactionId 
					}, {
							delay: 1000, 
							attempts: 8, 
							backoff: { type: 'exponential', delay: 3000 },
							removeOnComplete: { count: 1000 }, 
							removeOnFail: { count: 1000 }
					});

					return { action: 'LINK_SENT' };
			}
			return { action: 'RECONNECTING', instanceId: found.id };
	});

	fastify.put('/instances/:id/token', {
			schema: {
				 	hide: true,
					summary: 'تحديث توكين الحماية (Token)',
					description: 'تسمح لك هذه النقطة بتحديث التوكين السري الخاص بالجهاز. ملاحظة: يجب إرسال التوكين الحالي الصالح في ترويسة (Authorization Bearer) لتتمكن من تغييره.',
					tags: ['Settings'], 
                    security: [{ bearerAuth: [] }],
					params: { 
                        type: 'object', 
                        properties: { id: { type: 'string', description: 'معرف الجهاز (Instance ID)' } } 
                    },
					body: { 
                        type: 'object', 
                        required: ['newToken'], 
                        properties: { 
                            newToken: { 
                                type: 'string', 
                                minLength: 6,
                                description: 'التوكين الجديد الذي سيتم استخدامه للمصادقة في الطلبات القادمة' 
                            } 
                        } 
                    }
			}
	}, async (request: any, reply) => {
			const { id } = request.params;
			const { newToken } = request.body;

			const config = await InstanceManager.getConfig(id);
			if (!config || !config.token) {
                return reply.status(404).send({ error: 'النسخة غير موجودة أو لا تملك إعدادات صالحة' });
            }

			const updatedConfig = await InstanceManager.updateConfig(id, { token: newToken });

			return { 
                success: true, 
                message: 'تم تحديث التوكين بنجاح. يرجى استخدام التوكين الجديد في الطلبات القادمة.', 
                token: updatedConfig.token 
            };
	});
	
fastify.post('/instances/:id/messages/send', {
    schema: {
        summary: 'إرسال رسالة (Multipart)',
        description: 'إرسال نص أو وسائط باستخدام Multipart/form-data لتحسين أداء الذاكرة.',
        tags: ['Messages'],
        security: [{ bearerAuth: [] }],
        params: {
            type: 'object',
            properties: { id: { type: 'string', description: 'معرف الجهاز' } }
        },
        consume: ['multipart/form-data'],
        body: {
            type: 'object',
            properties: {
                jid: { type: 'string', description: 'رقم المستلم' },
                text: { type: 'string', description: 'نص الرسالة' },
                delay: { type: 'string', description: 'التأخير بالملي ثانية (للجدولة الاختيارية)' },
                file: { type: 'string', format: 'binary', description: 'الملف المراد إرساله' }
            }
        }
    },
    // 🌟 السطر السحري: إيقاف التحقق التلقائي لمنع خطأ 400 بسبب الـ Multipart 🌟
    validatorCompiler: () => () => true,
}, async (request: any, reply) => {
    const { id } = request.params;
    
    // قراءة البيانات بنظام Multipart
    const data = await request.file();
    if (!data) return reply.status(400).send({ error: 'الملف مفقود' });

    // استخراج البيانات من الحقول
    const rawJid = data.fields.jid?.value || ''; 
    const text = data.fields.text?.value || ''; 
    const delayStr = data.fields.delay?.value; // 🌟 إضافة استقبال قيمة الجدولة
    
    // تنظيف الرقم وتنسيقه ليتوافق مع مكتبة Baileys
    let jid = rawJid;
    if (!jid.includes('@')) {
        const cleanNumber = jid.replace(/[^0-9]/g, ''); 
        jid = `${cleanNumber}@s.whatsapp.net`; 
    }
    
    const sock = (InstanceManager as any).instances.get(id);
    const timestamp = new Date().toISOString();

    if (!sock || sock.status !== 'CONNECTED') {
        return reply.status(200).send({ 
            instanceId: id, instanceStatus: 'DISCONNECTED', waAccountStatus: 'unknown', transactionId: 'unknown', timestamp
        });
    }

    // تحويل الملف لـ Buffer ثم Base64 للطابور
    const fileBuffer = await data.toBuffer();
    const fileBase64 = fileBuffer.toString('base64');
    const mimetype = data.mimetype;
    const fileName = data.filename;
    const transactionId = nanoid(16);

    // تحديد نوع الملف للطابور
    let fileType = 'documentMessage';
    if (mimetype.startsWith('image/')) fileType = 'imageMessage';
    else if (mimetype.startsWith('video/')) fileType = 'videoMessage';
    else if (mimetype.startsWith('audio/')) fileType = 'audioMessage';

    // 🌟 تحويل الجدولة إلى رقم، إذا لم توجد نستخدم 1000 ملي ثانية الافتراضية 🌟

		let customDelay = 1000; // الإرسال الفوري كافتراضي
		if (delayStr) {
				const parsedDelay = parseInt(delayStr, 10);
				if (parsedDelay > 0) {
						customDelay = parsedDelay;
				}
		}
		
    // إرسال الرد السريع للفرونت إند
    reply.status(200).send({
        instanceId: id, instanceStatus: 'CONNECTED', waAccountStatus: 'exists', transactionId, timestamp, scheduledDelay: customDelay
    });

    // إضافة المهمة للطابور (مع الاعتماد على customDelay)
    await messageQueue.add('send', { 
        id, jid, text, file: fileBase64, fileName, mimetype, fileType, transactionId 
    }, {
        delay: customDelay, // 🌟 استخدام التأخير الديناميكي للجدولة أو الفوري 🌟
        attempts: 8,
        backoff: { type: 'exponential', delay: 3000 }
    });
});

	fastify.get('/instances/:id/config', { schema: { hide: true } }, async (request: any, reply) => {
			const { id } = request.params;
			const { magic } = request.query;

			const savedInstanceId = await redisConnection.get(`wa:magic:${magic}`);

			if (!savedInstanceId || savedInstanceId !== id) {
					return reply.status(403).send({ error: 'رابط منتهي أو غير صحيح' });
			}
			
			await redisConnection.del(`wa:magic:${magic}`);
			
			const config = await InstanceManager.getConfig(id);
			
			return { instanceId: id, apiToken: config.token, owner: config.owner, webhook: config.webhook };
	});

	fastify.post('/instances/:id/webhook', {
			schema: {
					hide: true,
					tags: ['Settings'], security: [{ bearerAuth: [] }],
					params: { type: 'object', properties: { id: { type: 'string' } } },
					body: { type: 'object', required: ['webhookUrl'], properties: { webhookUrl: { type: 'string' } } }
			}
	}, async (request: any, reply) => {
			const { id } = request.params;
			const { webhookUrl } = request.body;

			if (!InstanceManager.instances.has(id)) return reply.status(404).send({ error: 'النسخة غير موجودة' });

			const updatedConfig = await InstanceManager.updateConfig(id, { webhook: webhookUrl });

			return { success: true, message: 'تم تحديث الـ Webhook بنجاح', webhook: updatedConfig.webhook };
	});


	fastify.post('/instances/verify', {
			schema: {
					hide: true,
					tags: ['Instances'],
					body: {
							type: 'object',
							required: ['tokens'],
							properties: {
									tokens: { type: 'array', items: { type: 'string' } }
							}
					}
			}
	}, async (request: any, reply) => {
			const { tokens } = request.body;
			
			if (!tokens || !Array.isArray(tokens) || tokens.length === 0) {
					return [];
			}

			const allInstances = await InstanceManager.getAllInstances();
			const verifiedInstances = allInstances.filter(inst => tokens.includes(inst.token));
			
			return verifiedInstances;
	});

	fastify.post('/instances', { schema: { hide: true } }, async (request: any, reply) => {
			const { creation_secret } = request.body || {};
			if (creation_secret !== INSTANCE_SECRET_KEY) {
					return reply.status(403).send({ error: 'Forbidden', message: 'غير مصرح بإنشاء أجهزة' });
			}

			const id = nanoid(10);
			await InstanceManager.createInstance(id);
			const config = await InstanceManager.getConfig(id);
			return { instanceId: id, token: config.token };
	});

	fastify.delete('/instances/:id', { schema: { hide: true, security: [{ bearerAuth: [] }] } }, async (request: any) => {
			await InstanceManager.deleteInstance(request.params.id);
			return { success: true };
	});

	fastify.post('/test-webhook', { schema: { hide: true } }, async (request: any, reply) => {
			return reply.status(200).send({ success: true, message: 'Webhook received' });
	});

	fastify.get('/admin/all-accounts', {
			schema: {
					hide: true,
					summary: 'قائمة الحسابات للمدير فقط',
					tags: ['Admin'],
					security: [{ bearerAuth: [] }]
			}
	}, async (request: any, reply) => {
			const ADMIN_NUMBER = '966550558542';

			const adminInstanceId = request.headers['x-admin-instance-id']; 
			const config = await InstanceManager.getConfig(adminInstanceId);

			if (!config || config.owner !== `${ADMIN_NUMBER}@s.whatsapp.net`) {
					return reply.status(403).send({ error: 'غير مسموح', message: 'هذه الخاصية متاحة لمدير النظام فقط.' });
			}

			const allInstances = await InstanceManager.getAllRegisteredInstances();
			
			const connectedAccounts = allInstances.filter(inst => inst.status === 'CONNECTED');

			return {
					totalConnected: connectedAccounts.length,
					accounts: connectedAccounts
			};
	});

	async function acquireAppLock() {
			const lockKey = 'wa:system:app_lock';
			const lockTTL = 30; 
			
			const acquired = await redisConnection.set(lockKey, 'LOCKED', 'EX', lockTTL, 'NX');
			
			if (!acquired) {
					console.error('❌ [CRITICAL] محاولة تشغيل نسخة أخرى من النظام! يوجد سيرفر يعمل بالفعل. سيتم إيقاف هذه النسخة.');
					process.exit(1);
			}

			console.info('🔒 تم تفعيل قفل الحماية للنظام.');

			setInterval(async () => {
					await redisConnection.expire(lockKey, lockTTL);
			}, 15000);

			const releaseLock = async () => {
					await redisConnection.del(lockKey);
					console.info('🔓 تم تحرير قفل النظام.');
					process.exit(0);
			};

			process.on('SIGINT', releaseLock);
			process.on('SIGTERM', releaseLock);
	}

	async function autoCleanupZombies() {
			const instancesPath = './instances';
			if (!fs.existsSync(instancesPath)) return;

			const folders = fs.readdirSync(instancesPath);
			console.info(`🔍 [Cleanup] Starting scan for zombie folders in ${instancesPath}...`);

			for (const id of folders) {
					const fullPath = path.join(instancesPath, id);
					
					if (!fs.lstatSync(fullPath).isDirectory()) continue;

					// 2. استخدام دالتك الذكية المجهزة مسبقاً لجلب الإعدادات بأمان
					const config = await InstanceManager.getConfig(id);
					
					const sessionPath = path.join(fullPath, 'session', 'creds.json');
					const legacySessionPath = path.join(fullPath, 'creds.json');
					const hasLocalSession = fs.existsSync(sessionPath) || fs.existsSync(legacySessionPath);

					const isLinked = config && config.owner !== null;

					if (!isLinked && !hasLocalSession) {
							console.warn(`⚠️ [Cleanup] Zombie folder detected: "${id}". Unlinked and no local session. Deleting...`);
							try {
									fs.rmSync(fullPath, { recursive: true, force: true });
									await redisConnection.del(`wa:config:${id}`); 
									
									console.info(`✅ [Cleanup] Successfully removed zombie: "${id}"`);
							} catch (err: any) {
									console.error(`❌ [Cleanup] Failed to delete "${id}":`, err.message);
							}
					}
			}
	}

	const start = async () => {
			try {
					await acquireAppLock();
					await autoCleanupZombies();
					await fastify.listen({ port: 3000, host: '0.0.0.0' })
					const instancesPath = './instances';
					if (fs.existsSync(instancesPath)) {
							fs.readdirSync(instancesPath).forEach(id => {
									const fullPath = path.join(instancesPath, id);
									if(fs.lstatSync(fullPath).isDirectory()) {
											console.info(`🚀 [Startup] Restoring instance: ${id}`);
											InstanceManager.createInstance(id);
									}
							});
					}
			} catch (err) { console.log(`Starting Server error: ${err}`); process.exit(1); }
	}
	start();
}

bootstrap();