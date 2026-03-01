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

async function bootstrap() {
	const fastify = Fastify({ 
		bodyLimit: 10 * 1024 * 1024,
		logger: { level: 'error' },
		ajv: { customOptions: { strict: false, allErrors: true } } 
	})

	await fastify.register(cors, { 
			origin: true,
			methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
			allowedHeaders: ['Content-Type', 'Authorization'],
			credentials: true
	})

	await fastify.register(swagger, {
		openapi: {
					openapi: '3.1.0', // 🌟 تحديث الإصدار لدعم ميزة الـ Webhooks رسمياً
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
					// 🌟 توثيق الـ Webhooks التي سيتم إرسالها لخادم العميل
	// 🌟 توثيق الـ Webhooks بتفاصيل دقيقة وأمثلة
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
																							description: `**تفاصيل الحدث.** يختلف محتوى هذا الكائن بناءً على نوع الحدث (event).
																							
	**مثال لرسالة واردة (message_received):**
	\`\`\`json
	{
		"isGroup": false,
		"sender": "966500000000",
		"message": "مرحباً بكم",
		"timestamp": "2023-10-01T12:00:00.000Z"
	}
	\`\`\`

	**مثال لحالة توصيل (message_delivered):**
	\`\`\`json
	{
		"transactionId": "txn_12345abc",
		"messageId": "BAE5...",
		"recipient": "966500000000@s.whatsapp.net",
		"deliveryTimestamp": "2023-10-01T12:00:05.000Z"
	}
	\`\`\`
	`
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
					// 🌟 [تحديث: انتظار جلب البيانات من Redis]
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

	// 🌟 دمج الفرونت إند مع الباك إند
const frontendPath = path.join(process.cwd(), 'public');
	
	if (fs.existsSync(frontendPath)) {
			// 1. تسجيل إضافة تقديم الملفات الثابتة
			await fastify.register(fastifyStatic, {
					root: frontendPath,
					prefix: '/', // تقديم الملفات على المسار الرئيسي
					wildcard: false // إيقاف الوايلدكارد لنتمكن من معالجة أخطاء Vue Router بأنفسنا
			});

			// 2. حل مشكلة توجيهات Vue Router (SPA Fallback)
			// إذا طلب المستخدم مساراً غير موجود في الـ API، وكان المتصفح يطلب صفحة HTML، نرسل له index.html
			fastify.setNotFoundHandler((request, reply) => {
					if (request.method === 'GET' && request.headers.accept?.includes('text/html')) {
							reply.sendFile('index.html');
					} else {
							reply.status(404).send({ error: 'Not Found', message: 'المسار غير موجود' });
					}
			});
			
			console.log('✅ Frontend successfully integrated with Backend.');
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
			
			// تنظيف الرقم من علامة الزائد والمسافات قبل البحث
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

					const managementUrl = `http://localhost:3001/?manage=${found.id}&magic=${magicToken}`;
					
					// 🌟 [الإصلاح الجذري]: استخدام نظام الطوابير بدلاً من الإرسال المباشر
					const transactionId = `sys_magic_${nanoid(10)}`; // تمييزه كرسالة نظام لتسهيل تتبعها
					
					await messageQueue.add('send', { 
							id: found.id, 
							jid: jid, 
							text: `🔐 رابط الإدارة الخاص بك:\n${managementUrl}`, 
							transactionId 
					}, {
							delay: 1000, // تأخير بسيط لثانية واحدة
							attempts: 8, // المحاولة 8 مرات متصاعدة في حال الفشل
							backoff: { type: 'exponential', delay: 3000 },
							removeOnComplete: { count: 1000 }, // حفظه في لوحة Bull Board للمراقبة
							removeOnFail: { count: 1000 }
					});

					return { action: 'LINK_SENT' };
			}
			return { action: 'RECONNECTING', instanceId: found.id };
	});

	fastify.put('/instances/:id/token', {
			schema: {
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

			// التحقق من أن النسخة موجودة بالفعل (اختياري كزيادة أمان، لأن الـ preHandler يتحقق مسبقاً)
			const config = await InstanceManager.getConfig(id);
			if (!config || !config.token) {
                return reply.status(404).send({ error: 'النسخة غير موجودة أو لا تملك إعدادات صالحة' });
            }

            // تحديث التوكين وحفظه في Redis عبر الدالة المجهزة مسبقاً
			const updatedConfig = await InstanceManager.updateConfig(id, { token: newToken });

			return { 
                success: true, 
                message: 'تم تحديث التوكين بنجاح. يرجى استخدام التوكين الجديد في الطلبات القادمة.', 
                token: updatedConfig.token 
            };
	});
	
	fastify.post('/instances/:id/messages/send', {
			schema: {
					summary: 'إرسال رسالة (نصية أو مستند PDF)',
					description: 'تسمح لك هذه النقطة بإرسال رسائل نصية أو ملفات PDF إلى رقم واتساب محدد. يتم التحقق من وجود الرقم قبل الإرسال.',
					tags: ['Messages'],
					security: [{ bearerAuth: [] }],
					params: {
							type: 'object',
							properties: { id: { type: 'string', description: 'معرف الجهاز (Instance ID)' } }
					},
					body: {
							type: 'object',
							required: ['jid'],
							properties: {
									jid: { 
											type: 'string', 
											description: 'رقم المستلم مع رمز الدولة (مثال: 966500000000)' 
									},
									text: { 
											type: 'string', 
											description: 'نص الرسالة أو الوصف المصاحب للملف (Caption)' 
									},
									file: { 
											type: 'string', 
											description: `**محتوى الملف بتنسيق Base64.** \nيجب تحويل ملف الـ PDF إلى سلسلة نصية (Base64 String) قبل إرسالها. 
											\n*ملاحظة: لا ترسل رابط الملف أو المسار، بل المحتوى المشفر فقط.*` 
									},
									fileName: { 
											type: 'string', 
											description: 'اسم الملف الذي سيظهر للمستلم (مثال: invoice.pdf)' 
									}
							},
							// إضافة مثال توضيحي يظهر مباشرة في Swagger
							example: {
									jid: "966500000000",
									text: "مرفق لكم فاتورة الاشتراك",
									fileName: "invoice.pdf",
									file: "JVBERi0xLjQKJ... (Base64 content) ..."
							}
					}
			}
	}, async (request: any, reply) => {
			const { id } = request.params;
			const { jid, text, file, fileName } = request.body;
			const sock = (InstanceManager as any).instances.get(id);
			const timestamp = new Date().toISOString();

			if (!sock || sock.status !== 'CONNECTED') {
					return reply.status(200).send({ 
							instanceId: id, instanceStatus: 'DISCONNECTED', waAccountStatus: 'unknown', transactionId: 'unknown', timestamp
					});
			}

			const cleanNumber = jid.replace(/[^0-9]/g, ''); 
			const formattedJid = cleanNumber.includes('@s.whatsapp.net') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`;
			const [resultCheck] = await sock.onWhatsApp(formattedJid);

			if (!resultCheck || !resultCheck.exists) {
					return reply.status(200).send({ 
							instanceId: id, instanceStatus: 'CONNECTED', waAccountStatus: 'not_exists', transactionId: 'unknown', timestamp
					});
			}

			const finalJid = resultCheck.jid;
			const transactionId = nanoid(16); 

			reply.status(200).send({
					instanceId: id, instanceStatus: 'CONNECTED', waAccountStatus: 'exists', transactionId, timestamp
			});

			// 🌟 [تحديث: إضافة العملية إلى BullMQ مع تأخير عشوائي ونظام تكرار أُسّي Exponential Backoff]
			const initialDelay = Math.floor(Math.random() * 4000) + 1000;
			await messageQueue.add('send', { id, jid: finalJid, text, file, fileName, transactionId }, {
					delay: initialDelay,
					attempts: 8, 
					backoff: { type: 'exponential', delay: 3000 },
					removeOnComplete: { count: 1000 }, // 🌟 الاحتفاظ بآخر 1000 عملية ناجحة
					removeOnFail: { count: 1000 }      // 🌟 الاحتفاظ بآخر 1000 عملية فاشلة
				});
	});

	fastify.get('/instances/:id/config', { schema: { hide: true } }, async (request: any, reply) => {
			const { id } = request.params;
			const { magic } = request.query;

			const savedInstanceId = await redisConnection.get(`wa:magic:${magic}`);

			// التحقق مما إذا كان الرابط موجوداً ومطابقاً للجهاز المطلوب
			if (!savedInstanceId || savedInstanceId !== id) {
					return reply.status(403).send({ error: 'رابط منتهي أو غير صحيح' });
			}
			
			// 🌟 [التحديث]: حذف الرابط فوراً من Redis بعد الاستخدام الناجح لضمان استخدامه مرة واحدة فقط
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

	// ❌ تم حذف مسار GET /instances بالكامل لسد الثغرة الأمنية

	// 🌟 1. المسار الجديد: جلب الأجهزة بناءً على توكينات المتصفح فقط
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
			
			// إذا كان المتصفح جديداً ولا يحمل أي توكين، نرد بمصفوفة فارغة
			if (!tokens || !Array.isArray(tokens) || tokens.length === 0) {
					return [];
			}

			// جلب جميع الأجهزة من السيرفر
			const allInstances = await InstanceManager.getAllInstances();
			
			// فلترة الأجهزة: إرجاع الأجهزة التي يملك المتصفح التوكين الخاص بها فقط
			const verifiedInstances = allInstances.filter(inst => tokens.includes(inst.token));
			
			return verifiedInstances;
	});

	// 🌟 2. تحديث مسار الإنشاء: إرجاع التوكين مع الـ ID لكي يحفظه المتصفح
	fastify.post('/instances', { schema: { hide: true } }, async () => {
		const id = nanoid(10);
		await InstanceManager.createInstance(id);
			
			// جلب الإعدادات لإرجاع التوكين الذي تم توليده
			const config = await InstanceManager.getConfig(id);
			
		return { 
					instanceId: id,
					token: config.token // إرسال التوكين للفرونت إند ليحفظه
			};
	});

	fastify.delete('/instances/:id', { schema: { hide: true, security: [{ bearerAuth: [] }] } }, async (request: any) => {
			await InstanceManager.deleteInstance(request.params.id);
			return { success: true };
	});

	// 🧪 نقطة نهاية مؤقتة لاختبار الـ Webhook
	fastify.post('/test-webhook', { schema: { hide: true } }, async (request: any, reply) => {
			const time = new Date().toLocaleTimeString();
			console.log(`\n🔔 [${time}] تم استدعاء الـ Webhook التجريبي بنجاح!`);
			console.log('📦 محتوى الطلب (Body):');
			console.log(JSON.stringify(request.body, null, 2));
			console.log('--------------------------------------------------\n');
			return reply.status(200).send({ success: true, message: 'Webhook received' });
	});

	// أضف هذا الاستدعاء في الأعلى إذا لم يكن موجوداً

	// دالة حماية السيرفر من التعدد
	async function acquireAppLock() {
			const lockKey = 'wa:system:app_lock';
			const lockTTL = 30; // القفل صالح لمدة 30 ثانية
			
			// محاولة وضع مفتاح في Redis. سينجح فقط إذا لم يكن المفتاح موجوداً (NX)
			const acquired = await redisConnection.set(lockKey, 'LOCKED', 'EX', lockTTL, 'NX');
			
			if (!acquired) {
					console.error('❌ [CRITICAL] محاولة تشغيل نسخة أخرى من النظام! يوجد سيرفر يعمل بالفعل. سيتم إيقاف هذه النسخة.');
					process.exit(1); // إغلاق العملية فوراً
			}

			console.log('🔒 تم تفعيل قفل الحماية للنظام.');

			// تجديد القفل باستمرار طالما السيرفر يعمل (كل 15 ثانية)
			setInterval(async () => {
					await redisConnection.expire(lockKey, lockTTL);
			}, 15000);

			// تحرير القفل عند إغلاق السيرفر بشكل طبيعي
			const releaseLock = async () => {
					await redisConnection.del(lockKey);
					console.log('🔓 تم تحرير قفل النظام.');
					process.exit(0);
			};

			process.on('SIGINT', releaseLock);
			process.on('SIGTERM', releaseLock);
	}
	const start = async () => {
			try {
					await acquireAppLock();
					
					await fastify.listen({ port: 3000, host: '0.0.0.0' })
					const instancesPath = './instances';
					if (fs.existsSync(instancesPath)) {
							fs.readdirSync(instancesPath).forEach(id => {
									const fullPath = path.join(instancesPath, id);
									// 🌟 التأكد من أنه مجلد وليس ملفاً عادياً
									if(fs.lstatSync(fullPath).isDirectory()) {
											console.log(`🚀 [Startup] Restoring instance: ${id}`);
											InstanceManager.createInstance(id);
									}
							});
					}
			} catch (err) { process.exit(1) }
	}
	start();
}

bootstrap();