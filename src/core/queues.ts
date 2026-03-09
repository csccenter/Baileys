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
    // 1. استخراج الحقول الجديدة (mimetype, fileType) من بيانات المهمة
    const { id, jid, text, file, fileName, mimetype, fileType, transactionId } = job.data;
    
    const sock = InstanceManager.instances.get(id);

    if (!sock) {
        console.warn(`⚠️ [MessageQueue] Instance ${id} is completely deleted. Dropping job ${job.id}.`);
        return; 
    }

    if (sock.status !== 'CONNECTED') {
        throw new Error(`[Retry] Instance ${id} is temporarily disconnected. Will retry later.`);
    }

    let result: any;

    await sock.sendPresenceUpdate('composing', jid);
    await humanDelay(text);

    if (file) {
        // 2. إنشاء كائن الوسائط ديناميكياً بناءً على نوع الملف القادم من السيرفر
        const mediaContent: any = {
            caption: text,
            mimetype: mimetype, // استخدام المايم تايب الحقيقي بدلاً من الثابت
        };

        // تحويل Base64 إلى Buffer
        const fileBuffer = Buffer.from(file, 'base64');

        // 3. تحديد الحقل المناسب في Baileys بناءً على fileType
        if (fileType === 'imageMessage') {
            mediaContent.image = fileBuffer;
        } else if (fileType === 'videoMessage') {
            mediaContent.video = fileBuffer;
        } else if (fileType === 'audioMessage') {
            mediaContent.audio = fileBuffer;
        } else {
            // الحالة الافتراضية للمستندات
            mediaContent.document = fileBuffer;
            mediaContent.fileName = fileName || 'document.pdf';
        }

        result = await sock.sendMessage(jid, mediaContent);
    } else {
        result = await sock.sendMessage(jid, { text });
    }

    await sock.sendPresenceUpdate('paused', jid);

    // حفظ بيانات العملية لإرسال الـ Webhook لاحقاً
    if (result?.key?.id) {
        const messageId = result.key.id;
        const sendTimestamp = new Date().toISOString();
        await redisConnection.setex(`wa:txn:${messageId}`, 604800, JSON.stringify({ transactionId, sendTimestamp }));
        
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
    
}, { connection: connectionOptions });

webhookWorker.on('failed', (job, err) => {
    if (job) {
        const identifier = job.data.payload?.transactionId ? `txn: ${job.data.payload.transactionId}` : `Event: ${job.data.payload.event}`;
        console.error(`⚠️ [WebhookQueue] Job failed for ${identifier}: ${err.message}`);
    }
});

const delay = (ms: number) => new Promise(res => setTimeout(res, ms))

const humanDelay = async (text?: string) => {
    if (!text) return delay(1500)
    const typingTime = Math.min(6000, text.length * 50)
    await delay(typingTime)
}