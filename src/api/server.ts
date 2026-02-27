import Fastify from 'fastify'
import cors from '@fastify/cors'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { InstanceManager } from '../core/instance-manager.js'
import { nanoid } from 'nanoid'
import fs from 'fs'
import path from 'path'

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

const magicLinks = new Map<string, { instanceId: string, expires: number }>();

fastify.addHook('preHandler', async (request, reply) => {
    const url = request.url;
    const { id } = request.params as { id: string };
    const method = request.method;

    const isPublic = url.startsWith('/docs') || 
                     url.startsWith('/auth/request-link') || 
                     (url === '/instances' && method === 'GET') ||
                     (url === '/instances' && method === 'POST') ||
                     url.includes('/config');

    if (isPublic) return;

    if (id) {
        const instance = InstanceManager.getInstance(id);

        if (method === 'DELETE' && (!instance || instance.status !== 'CONNECTED')) {
            return; 
        }

        // جلب التوكين من الإعدادات الجديدة
        const config = InstanceManager.getConfig(id);
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
        body: {
            type: 'object',
            required: ['phoneNumber'],
            properties: { phoneNumber: { type: 'string' } }
        }
    }
}, async (request: any) => {
    const { phoneNumber } = request.body;
    const jid = `${phoneNumber}@s.whatsapp.net`;
    const instances = InstanceManager.getAllInstances();
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
            properties: {
                jid: { type: 'string' },
                text: { type: 'string' },
                file: { type: 'string' },
                fileName: { type: 'string' }
            }
        }
    }
}, async (request: any, reply) => {
    const { id } = request.params;
    const { jid, text, file, fileName } = request.body;
    const sock = (InstanceManager as any).instances.get(id);

    if (!sock || sock.status !== 'CONNECTED') return reply.status(400).send({ error: 'الجهاز غير متصل' });

    const cleanNumber = jid.replace(/[^0-9]/g, ''); 
    const formattedJid = cleanNumber.includes('@s.whatsapp.net') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`;

    const [resultCheck] = await sock.onWhatsApp(formattedJid);

    if (!resultCheck || !resultCheck.exists) {
        return reply.status(404).send({ 
            status: 'failed', 
            error: 'الرقم غير مسجل في واتساب أو غير صحيح' 
        });
    }

    const finalJid = resultCheck.jid;

    try {
        let result;
        if (file) {
            result = await sock.sendMessage(finalJid, {
                document: Buffer.from(file, 'base64'),
                mimetype: 'application/pdf',
                fileName: fileName || 'document.pdf',
                caption: text
            });
        } else {
            result = await sock.sendMessage(finalJid, { text });
        }
        return { status: 'sent', messageId: result?.key.id };
    } catch (err: any) {
        return reply.status(500).send({ error: err.message });
    }
});

fastify.get('/instances/:id/config', async (request: any, reply) => {
    const { id } = request.params;
    const { magic } = request.query;
    const linkData = magicLinks.get(magic);
    
    if (!linkData || linkData.instanceId !== id || linkData.expires < Date.now()) {
        return reply.status(403).send({ error: 'رابط منتهي أو غير صحيح' });
    }
    
    magicLinks.delete(magic);
    
    // جلب الإعدادات الموحدة
    const config = InstanceManager.getConfig(id);
    
    return {
        instanceId: id,
        apiToken: config.token,
        owner: config.owner,
        webhook: config.webhook // إعادة الويب هوك للفرونت إند
    };
});

// --- مسار جديد لإضافة أو تعديل الـ Webhook ---
fastify.post('/instances/:id/webhook', {
    schema: {
        tags: ['Settings'],
        security: [{ bearerAuth: [] }],
        params: { type: 'object', properties: { id: { type: 'string' } } },
        body: {
            type: 'object',
            required: ['webhookUrl'],
            properties: {
                webhookUrl: { type: 'string' }
            }
        }
    }
}, async (request: any, reply) => {
    const { id } = request.params;
    const { webhookUrl } = request.body;

    if (!InstanceManager.instances.has(id)) {
        return reply.status(404).send({ error: 'النسخة غير موجودة' });
    }

    const updatedConfig = InstanceManager.updateConfig(id, { webhook: webhookUrl });

    return { 
        success: true, 
        message: 'تم تحديث الـ Webhook بنجاح',
        webhook: updatedConfig.webhook
    };
});

fastify.get('/instances', async () => InstanceManager.getAllInstances());

fastify.post('/instances', async () => {
	const id = nanoid(10);
	await InstanceManager.createInstance(id);
	return { instanceId: id };
});

fastify.delete('/instances/:id', {
    schema: { security: [{ bearerAuth: [] }] }
}, async (request: any) => {
    await InstanceManager.deleteInstance(request.params.id);
    return { success: true };
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