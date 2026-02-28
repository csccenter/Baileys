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
import { messageQueue, webhookQueue } from '../core/queues.js'

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
		info: { title: 'WhatsApp Secure API', version: '1.0.0' },
		components: {
			securitySchemes: {
				bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }
			}
		}
	}
})
await fastify.register(swaggerUi, { routePrefix: '/docs' })

const serverAdapter = new FastifyAdapter();
createBullBoard({
    queues: [
        new BullMQAdapter(messageQueue),
        new BullMQAdapter(webhookQueue)
    ],
    serverAdapter,
});
serverAdapter.setBasePath('/admin/queues');

fastify.register(serverAdapter.registerPlugin(), { prefix: '/admin/queues' });

const magicLinks = new Map<string, { instanceId: string, expires: number }>();

fastify.addHook('preHandler', async (request, reply) => {
    const url = request.url;
    const { id } = request.params as { id: string };
    const method = request.method;

    const isPublic = url.startsWith('/docs') || 
											url.startsWith('/admin/queues') ||
                     url.startsWith('/auth/request-link') || 
                     (url === '/instances' && method === 'GET') ||
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

fastify.post('/auth/request-link', {
    schema: {
        tags: ['Authentication'],
        body: { type: 'object', required: ['phoneNumber'], properties: { phoneNumber: { type: 'string' } } }
    }
}, async (request: any) => {
    const { phoneNumber } = request.body;
    const jid = `${phoneNumber}@s.whatsapp.net`;
    
    // 🌟 [تحديث: الدالة أصبحت Async]
    const instances = await InstanceManager.getAllInstances();
    const found = instances.find(inst => inst.owner === jid);

    if (!found) {
        const id = nanoid(10);
        await InstanceManager.createInstance(id);
        return { action: 'SCAN_QR', instanceId: id };
    }

    const sock = (InstanceManager as any).instances.get(found.id);
    if (found.status === 'CONNECTED' && sock) {
        const magicToken = nanoid(32);
        magicLinks.set(magicToken, { instanceId: found.id, expires: Date.now() + 600000 });
        const managementUrl = `http://localhost:5173/?manage=${found.id}&magic=${magicToken}`;
        await sock.sendMessage(jid, { text: `🔐 رابط الإدارة الخاص بك:\n${managementUrl}` });
        return { action: 'LINK_SENT' };
    }
    return { action: 'RECONNECTING', instanceId: found.id };
});

fastify.post('/instances/:id/messages/send', {
    schema: {
        tags: ['Messages'],
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } } },
        body: {
            type: 'object',
            required: ['jid'],
            properties: { jid: { type: 'string' }, text: { type: 'string' }, file: { type: 'string' }, fileName: { type: 'string' } }
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

fastify.get('/instances/:id/config', async (request: any, reply) => {
    const { id } = request.params;
    const { magic } = request.query;
    const linkData = magicLinks.get(magic);
    
    if (!linkData || linkData.instanceId !== id || linkData.expires < Date.now()) {
        return reply.status(403).send({ error: 'رابط منتهي أو غير صحيح' });
    }
    
    magicLinks.delete(magic);
    const config = await InstanceManager.getConfig(id);
    
    return { instanceId: id, apiToken: config.token, owner: config.owner, webhook: config.webhook };
});

fastify.post('/instances/:id/webhook', {
    schema: {
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

fastify.get('/instances', async () => await InstanceManager.getAllInstances());

fastify.post('/instances', async () => {
	const id = nanoid(10);
	await InstanceManager.createInstance(id);
	return { instanceId: id };
});

fastify.delete('/instances/:id', { schema: { security: [{ bearerAuth: [] }] } }, async (request: any) => {
    await InstanceManager.deleteInstance(request.params.id);
    return { success: true };
});

// 🧪 نقطة نهاية مؤقتة لاختبار الـ Webhook
fastify.post('/test-webhook', async (request: any, reply) => {
    const time = new Date().toLocaleTimeString();
    console.log(`\n🔔 [${time}] تم استدعاء الـ Webhook التجريبي بنجاح!`);
    console.log('📦 محتوى الطلب (Body):');
    console.log(JSON.stringify(request.body, null, 2));
    console.log('--------------------------------------------------\n');
    return reply.status(200).send({ success: true, message: 'Webhook received' });
});

const start = async () => {
	try {
		await fastify.listen({ port: 3000, host: '0.0.0.0' })
		const instancesPath = './instances';
		if (fs.existsSync(instancesPath)) {
			fs.readdirSync(instancesPath).forEach(id => {
                const fullPath = path.join(instancesPath, id);
                if(fs.lstatSync(fullPath).isDirectory()) InstanceManager.createInstance(id);
            });
		}
	} catch (err) { process.exit(1) }
}
start();