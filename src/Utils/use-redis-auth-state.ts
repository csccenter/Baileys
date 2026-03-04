import { proto } from '../../WAProto/index.js'
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from '../Types'
import { initAuthCreds } from './auth-utils.js'
import { BufferJSON } from './generics.js'

// 1. الواجهة المخصصة (Custom Interface) لحل تعارض TypeScript
export interface SimpleRedisClient {
    hSet(key: string, field: string, value: string): Promise<any>;
    hGet(key: string, field: string): Promise<string | undefined | null>;
    hDel(key: string, field: string): Promise<any>;
}

export const useRedisAuthState = async (
    sessionId: string,
    redisClient: SimpleRedisClient
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> => {
    
    const sessionKey = `wa:session:${sessionId}`

    const writeData = async (data: any, field: string) => {
        try {
            const stringified = JSON.stringify(data, BufferJSON.replacer)
            await redisClient.hSet(sessionKey, field, stringified)
        } catch (error) {
            console.error(`[Redis Write Error] Session: ${sessionId}, Field: ${field}`, error)
        }
    }

    const readData = async (field: string) => {
        try {
            const value = await redisClient.hGet(sessionKey, field)
            if (value) {
                return JSON.parse(value, BufferJSON.reviver)
            }
        } catch (error) {
            console.error(`[Redis Read Error] Session: ${sessionId}, Field: ${field}`, error)
        }
        return null
    }

    const removeData = async (field: string) => {
        try {
            await redisClient.hDel(sessionKey, field)
        } catch (error) {
            console.error(`[Redis Delete Error] Session: ${sessionId}, Field: ${field}`, error)
        }
    }

    let creds: AuthenticationCreds
    const credsData = await readData('creds')
    if (credsData) {
        creds = credsData
    } else {
        creds = initAuthCreds()
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data: { [_: string]: SignalDataTypeMap[typeof type] } = {}
                    await Promise.all(
                        ids.map(async id => {
                            let value = await readData(`${type}-${id}`)
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value)
                            }
                            data[id] = value as SignalDataTypeMap[typeof type]
                        })
                    )
                    return data
                },
                set: async data => {
                    const tasks: Promise<void>[] = []
                    for (const category in data) {
                        for (const id in data[category as keyof SignalDataTypeMap]) {
                            const value = data[category as keyof SignalDataTypeMap]![id]
                            const field = `${category}-${id}`
                            tasks.push(value ? writeData(value, field) : removeData(field))
                        }
                    }
                    await Promise.all(tasks)
                }
            }
        },
        saveCreds: async () => {
            await writeData(creds, 'creds')
            // 🌟 السطر الجديد: تسجيل الطابع الزمني (Timestamp) في كل مرة يتم فيها تحديث الجلسة
            try {
                await redisClient.hSet(sessionKey, 'last_modified', Date.now().toString());
            } catch (error) {
                console.error(`[Redis Timestamp Error] Session: ${sessionId}`, error);
            }
        }
    }
}