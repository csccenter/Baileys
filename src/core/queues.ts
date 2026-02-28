import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { InstanceManager } from './instance-manager';

// 🌟 [تحديث: فصل إعدادات الاتصال لتمريرها ككائن لـ BullMQ]
const connectionOptions = {
    host: '127.0.0.1',
    port: 6379,
    maxRetriesPerRequest: null // مطلوب دائماً من BullMQ
};

// اتصال Redis المخصص لعمليات الكاش السريعة (مثل حفظ إعدادات النسخة)
export const redisConnection = new IORedis(connectionOptions);

redisConnection.on('error', (err) => console.error('❌ IORedis Error:', err.message));
redisConnection.on('connect', () => console.log('✅ Connected to IORedis successfully (Cache)'));

// 1. إنشاء طوابير المهام (نمرر إعدادات الاتصال بدلاً من النسخة)
export const messageQueue = new Queue('MessageQueue', { connection: connectionOptions });
export const webhookQueue = new Queue('WebhookQueue', { connection: connectionOptions });

// ==========================================
// 2. العامل الأول: مُرسل الرسائل (Message Worker)
// ==========================================
const messageWorker = new Worker('MessageQueue', async (job: Job) => {
    const { id, jid, text, file, fileName, transactionId } = job.data;
    
    const sock = InstanceManager.instances.get(id);
    if (!sock || sock.status !== 'CONNECTED') {
        throw new Error(`[Retry] Instance ${id} is not connected right now.`);
    }

    let result: any;
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

    // إذا نجح الإرسال، نحفظ بيانات العملية ونرسل إشعار الويب هوك
    if (result?.key?.id) {
        const messageId = result.key.id;
        const sendTimestamp = new Date().toISOString();

        // حفظ العملية في Redis لمدة 7 أيام (604800 ثانية) لتتبع الاستلام
        await redisConnection.setex(`wa:txn:${messageId}`, 604800, JSON.stringify({ transactionId, sendTimestamp }));

        // إضافة مهمة إرسال ويب هوك إلى طابور الويب هوكات
        await webhookQueue.add('send-webhook', {
            instanceId: id,
            payload: {
                event: 'message_sent',
                instanceId: id,
                transactionId,
                messageId,
                sendTimestamp,
                deliveryTimestamp: null,
                recipient: jid
            }
        }, { 
            attempts: 8, 
            backoff: { type: 'exponential', delay: 3000 },
            removeOnComplete: true,
            removeOnFail: false
        });
    }
}, { connection: connectionOptions });

messageWorker.on('failed', (job, err) => {
    if (job) console.error(`⚠️ [MessageQueue] Job ${job.id} failed (Txn: ${job.data.transactionId}): ${err.message}`);
});

// ==========================================
// 3. العامل الثاني: مُرسل الويب هوك (Webhook Worker)
// ==========================================
const webhookWorker = new Worker('WebhookQueue', async (job: Job) => {
    const { instanceId, payload } = job.data;
    
    // سحب الإعدادات بشكل غير متزامن من Redis
    const config = await InstanceManager.getConfig(instanceId);
    if (!config || !config.webhook) return;

    const response = await fetch(config.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        throw new Error(`HTTP Status: ${response.status}`);
    }
    
    console.log(`✅ [Webhook] Sent successfully for Event: ${payload.event}`);
}, { connection: connectionOptions });

webhookWorker.on('failed', (job, err) => {
    if (job) {
        const identifier = job.data.payload?.transactionId ? `txn: ${job.data.payload.transactionId}` : `Event: ${job.data.payload.event}`;
        console.error(`⚠️ [WebhookQueue] Job failed for ${identifier}: ${err.message}`);
    }
});