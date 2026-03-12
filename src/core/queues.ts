import { Queue, Worker, Job, DelayedError } from 'bullmq';
import IORedis from 'ioredis';
import { InstanceManager } from './instance-manager';
import fs from 'fs';

import * as dotenv from 'dotenv';
dotenv.config();

const connectionOptions = {
    host: '127.0.0.1',
    port: 6379,
    maxRetriesPerRequest: null 
};

export const redisConnection = new IORedis(connectionOptions);

redisConnection.on('error', (err) => console.error('❌ IORedis Error:', err.message));
redisConnection.on('connect', () => console.log('✅ Connected to IORedis successfully (Cache)'));

// 🌟 التعديل هنا: إضافة defaultJobOptions لحماية Redis من الامتلاء عن طريق الاحتفاظ بـ 50 مهمة فقط كحد أقصى لكل حالة
export const messageQueue = new Queue('MessageQueue', { 
    connection: connectionOptions,
    defaultJobOptions: {
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 50 }
    }
});

export const webhookQueue = new Queue('WebhookQueue', { 
    connection: connectionOptions,
    defaultJobOptions: {
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 50 }
    }
});

// ==========================================
// 2. العامل الأول: مُرسل الرسائل (Message Worker)
// ==========================================
const messageWorker = new Worker('MessageQueue', async (job: Job, token?: string) => {
    const { id, jid, text, filePath, fileName, mimetype, fileType, transactionId } = job.data;
    
    const sock = InstanceManager.instances.get(id);

    if (!sock) {
        console.warn(`⚠️ [MessageQueue] Instance ${id} is completely deleted. Dropping job ${job.id}.`);
        return; 
    }

    if (sock.status !== 'CONNECTED') {
        throw new Error(`[Retry] Instance ${id} is temporarily disconnected. Will retry later.`);
    }

    const MAX_MSGS_PER_MINUTE = 15; 
    const limitKey = `wa:ratelimit:${id}`;
    
    const msgCount = await redisConnection.incr(limitKey);
    if (msgCount === 1) {
        await redisConnection.expire(limitKey, 60); 
    }
    
    if (msgCount > MAX_MSGS_PER_MINUTE) {
        const ttl = await redisConnection.ttl(limitKey);
        const waitTime = (ttl > 0 ? ttl : 60) * 1000;
        console.info(`⏳ [Rate Limit] Instance ${id} reached limit. Delaying job ${job.id} for ${waitTime}ms.`);
        
        if (token) {
            await job.moveToDelayed(Date.now() + waitTime, token);
        }
        throw new DelayedError();
    }

    let result: any;

    await sock.sendPresenceUpdate('composing', jid);
    await humanDelay(text);

    if (filePath && fs.existsSync(filePath)) {
        const mediaContent: any = {
            caption: text,
            mimetype: mimetype, 
        };

        if (fileType === 'imageMessage') {
            mediaContent.image = { url: filePath };
        } else if (fileType === 'videoMessage') {
            mediaContent.video = { url: filePath };
        } else if (fileType === 'audioMessage') {
            mediaContent.audio = { url: filePath };
        } else {
            mediaContent.document = { url: filePath };
            mediaContent.fileName = fileName || 'document.pdf';
        }

        result = await sock.sendMessage(jid, mediaContent);
    } else {
        result = await sock.sendMessage(jid, { text });
    }

    await sock.sendPresenceUpdate('paused', jid);

    if (result?.key?.id) {
        const messageId = result.key.id;
        const sendTimestamp = new Date().toISOString();
        await redisConnection.setex(`wa:txn:${messageId}`, 604800, JSON.stringify({ transactionId, sendTimestamp }));
        
        await webhookQueue.add('helpdesk-webhook', {
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

// ==========================================
// 🌟 دوال التنظيف الآمن للملفات المؤقتة
// ==========================================
const cleanupTempFile = (job: Job | undefined) => {
    if (job && job.data && job.data.filePath) {
        fs.unlink(job.data.filePath, (err) => {
            if (err && err.code !== 'ENOENT') { 
                console.error(`⚠️ Failed to delete temporary file ${job.data.filePath}:`, err.message);
            }
        });
    }
};

messageWorker.on('completed', (job) => {
    cleanupTempFile(job);
});

messageWorker.on('failed', (job, err) => {
    if (job) {
        console.error(`⚠️ [MessageQueue] Job ${job.id} failed (Txn: ${job.data.transactionId}): ${err.message}`);
        const maxAttempts = job.opts.attempts || 1;
        if (job.attemptsMade >= maxAttempts) {
            console.info(`🗑️ [Cleanup] Job ${job.id} completely failed. Removing temp file.`);
            cleanupTempFile(job);
        }
    }
});

// ==========================================
// 3. العامل الثاني: مُرسل الويب هوك (Webhook Worker)
// ==========================================
const webhookWorker = new Worker('WebhookQueue', async (job: Job) => {
    const { instanceId, payload } = job.data;
    
    // 🌟 المعالجة الجديدة الخاصة بنظام خدمة العملاء (Helpdesk)
    if (job.name === 'helpdesk-webhook') {
        const helpdeskUrl = process.env.HELPDESK_WEBHOOK;
        const helpdeskToken = process.env.HELPDESK_TOKEN;

        if (!helpdeskUrl) {
            console.warn(`⚠️ [WebhookQueue] HELPDESK_WEBHOOK is not defined in .env`);
            return;
        }

        const response = await fetch(helpdeskUrl, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'x-baileys-token': `${helpdeskToken}`
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error(`Helpdesk HTTP Status: ${response.status}`);
        }
        return; // إنهاء التنفيذ هنا حتى لا يكمل للويب هوك العادي
    } else {
        // المعالجة القديمة (الويب هوك المخصص لكل جهاز)
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
    }


    
}, { connection: connectionOptions });

webhookWorker.on('failed', (job, err) => {
    if (job) {
        const identifier = job.data.payload?.transactionId ? `txn: ${job.data.payload.transactionId}` : `Event: ${job.data.payload.event}`;
        console.error(`⚠️ [WebhookQueue] Job failed for ${identifier}: ${err.message}`);
    }
});

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

const humanDelay = async (text?: string) => {
    if (!text) {
        const randomMediaDelay = Math.floor(Math.random() * (2500 - 1000 + 1) + 1000);
        return delay(randomMediaDelay);
    }
    
    const baseTime = text.length * 50; 
    const cappedTime = Math.min(8000, Math.max(1000, baseTime)); 
    
    const jitter = cappedTime * 0.3;
    const finalDelay = Math.floor(cappedTime + (Math.random() * jitter * 2) - jitter);
    
    await delay(finalDelay);
}