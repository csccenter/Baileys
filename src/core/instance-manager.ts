import makeWASocket, { 
	useMultiFileAuthState, 
	DisconnectReason, 
	fetchLatestBaileysVersion,
	makeCacheableSignalKeyStore,
	type WASocket 
} from '../index.js' 
import { type Boom } from '@hapi/boom'
import pino from 'pino'
import path from 'path'
import fs from 'fs'
import QRCode from 'qrcode'
import NodeCache from 'node-cache'
import * as crypto from "crypto"; // أو استخدم crypto العادي من node
// أو استخدم crypto العادي من node

interface ExtendedSocket extends WASocket {
	qr?: string
	status?: 'WAITING' | 'CONNECTED' | 'CLOSED'
	ownerJid?: string
}

export class InstanceManager {
	public static instances = new Map<string, ExtendedSocket>() // جعلتها public للوصول إليها من السيرفر
	private static msgRetryCounterCache = new NodeCache()
	
	static {
		if (!fs.existsSync('./instances')) fs.mkdirSync('./instances')
	}

	// دالة مساعدة للحصول على التوكين أو إنشائه
	static getOrGenerateToken(id: string): string {
		const tokenPath = path.join('./instances', id, 'token.txt');
		if (fs.existsSync(tokenPath)) {
			return fs.readFileSync(tokenPath, 'utf-8');
		}
		const newToken = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
		fs.writeFileSync(tokenPath, newToken);
		return newToken;
	}

	// دالة للحصول على رقم المالك المخزن
	static getOwner(id: string): string | null {
		const ownerPath = path.join('./instances', id, 'owner.txt');
		return fs.existsSync(ownerPath) ? fs.readFileSync(ownerPath, 'utf-8') : null;
	}

	static async createInstance(id: string) {
			const authPath = path.join('./instances', id)
			const { state, saveCreds } = await useMultiFileAuthState(authPath)
			const { version } = await fetchLatestBaileysVersion()

			const sock = makeWASocket({
					version,
					logger: pino({ level: 'silent' }),
					auth: {
							creds: state.creds,
							keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
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
									// حفظ رقم المالك في ملف للرجوع إليه لاحقاً
									fs.writeFileSync(path.join(authPath, 'owner.txt'), userJid);
									// تأمين وجود توكين
									this.getOrGenerateToken(id);
									console.log(`✅ [Instance: ${id}] Connected as ${userJid}`);
							}

							if (connection === 'close') {
								const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
								if (statusCode !== DisconnectReason.loggedOut && this.instances.has(id)) {
									setTimeout(() => this.createInstance(id), 3000);
								}
							}
					}

					if (events['creds.update']) {
							await saveCreds()
					}
			})

			this.instances.set(id, sock)
			return sock
	}

	static getAllInstances() {
		const list: any[] = [];
		this.instances.forEach((sock, id) => {
			list.push({
				id,
				status: sock.status,
				owner: this.getOwner(id),
				qr: sock.qr || null
			});
		});
		return list;
	}

	static getInstance(id: string) {
		const sock = this.instances.get(id)
		if (!sock) return null
		return {
			id,
			status: sock.status,
			owner: this.getOwner(id),
			qr: sock.qr || null
		}
	}

	static async deleteInstance(id: string) {
      const sock = this.instances.get(id);
      this.instances.delete(id);

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
  }
}