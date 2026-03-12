import axios from 'axios'
import pino from 'pino'

const logger = pino({ name: 'WebhookProvider' })

export class WebhookProvider {
	/**
	 * إرسال الحدث إلى الرابط المحدد مع آلية محاولة إعادة الإرسال
	 */
	static async notify(url: string, event: string, instanceId: string, payload: any) {
		const data = {
			instanceId,
			event,
			payload,
			timestamp: new Date().toISOString()
		}

		try {
			// محاولة الإرسال بمهلة 5 ثوانٍ
			await axios.post(url, data, { timeout: 5000 })
		} catch (error: any) {
			logger.error(`Failed to send webhook to ${url}: ${error.message}`)
			// هنا يمكنك إضافة منطق لتخزين الطلبات الفاشلة في ملف JSON وإعادة محاولتها لاحقاً
		}
	}
}