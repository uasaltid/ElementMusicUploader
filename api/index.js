import * as modedCrypto from './Crypto.js'
import crypto from 'crypto'
import MessagePack from 'msgpack-lite'

var url = 'wss://ws.elemsocial.com/user_api'
var socket = null
var isConnected = false
var rsaPublic = null
var rsaPrivate = null
var rsaPublicServer = null
var aesKey = null
var aesServerKey = null
var keysReady = false
var socketReady = false
var messageQueue = []
var processingMessages = false
var mesCount = 0
const rayIDQueue = {}

async function generateKeys() {
    var keyPair = await crypto.subtle.generateKey({
        name: 'RSA-OAEP',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: { name: 'SHA-256' }
    }, true, ['encrypt', 'decrypt']);
    rsaPublic = await crypto.subtle.exportKey('spki', keyPair.publicKey);
    rsaPrivate = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
    keysReady = true;
    return true;
}

// Обработка очереди сообщений, ожидающих отправки
function processQueue() {
    if (!socketReady || processingMessages) return;
    processingMessages = true;
    while (messageQueue.length > 0) {
        var message = messageQueue.shift();
        send(message);
    }
    processingMessages = false;
}

// Устанавливаем соединение с сервером
export const connect = () => new Promise(r => {
    socket = new WebSocket(url)

    socket.onopen = async function () {
        await generateKeys()
        var publicKeyPem = modedCrypto.arrayBufferToPem(rsaPublic, 'PUBLIC KEY');
        socket.send(JSON.stringify({
            type: 'key_exchange',
            key: publicKeyPem
        }));
        isConnected = true;
        processQueue();
    };

    socket.onmessage = async function (event) {
        var rawData = event.data;

        if (rsaPublicServer) {
            if (aesServerKey) {
                const unit8Array = await modedCrypto.blobToUint8Array(rawData);
                const decryptedAes = await modedCrypto.aesDecrypt(unit8Array, aesKey);
                const decryptedData = MessagePack.decode(Buffer.from(decryptedAes));

                if (rayIDQueue?.[decryptedData.ray_id]) {
                    rayIDQueue[decryptedData.ray_id](decryptedData)
                    delete rayIDQueue[decryptedData.ray_id]
                }
            } else {
                const unit8Array = await modedCrypto.blobToUint8Array(rawData);
                const decryptedRsa = await modedCrypto.rsaDecrypt(unit8Array, rsaPrivate);
                const decryptedData = MessagePack.decode(Buffer.from(decryptedRsa));

                if (decryptedData.type && decryptedData.type === 'aes_key') {
                    aesServerKey = decryptedData.key;
                    socketReady = true;
                    // ВСЁ СОКЕТ ГОТОВ ПИЗДЕТЬ
                    
                    r();
                }
            }
        } else {
            var data = JSON.parse(rawData);
            if (data.type === 'key_exchange') {
                rsaPublicServer = data.key;
                aesKey = modedCrypto.generateAESKey();
                const aesKeyPayload = MessagePack.encode({
                    type: 'aes_key',
                    key: aesKey
                });
                const encryptedPayload = await modedCrypto.rsaEncrypt(aesKeyPayload, rsaPublicServer);
                socket?.send(encryptedPayload);
            }
        }
    };
    socket.onclose = function () {
        disconnect();
        setTimeout(connect, 5000);
    };

    socket.onerror = function () {
        disconnect();
        setTimeout(connect, 5000);
    };
})

export async function send(data) {
    data.ray_id = await generateRayID()

    if (!isConnected || !socket || socket.readyState !== WebSocket.OPEN || !socketReady) {
        messageQueue.push(data);
        console.log(data)
        
        return new Promise(r => rayIDQueue[data.ray_id] = r )
    }

    const binaryData = MessagePack.encode({ ...data });
    const encrypted = await modedCrypto.aesEncrypt(binaryData, aesServerKey);
    socket.send(encrypted);

    return new Promise((resolve, reject) => {
        const onMessage = async (event) => {
            try {
                const unit8Array = await modedCrypto.blobToUint8Array(event.data);
                const decryptedAes = await modedCrypto.aesDecrypt(unit8Array, aesKey);
                const decryptedData = MessagePack.decode(Buffer.from(decryptedAes));

                if (decryptedData.ray_id === data.ray_id) {
                    socket.removeEventListener('message', onMessage);
                    resolve(decryptedData);
                }
            } catch (error) {
                reject(error);
            }
        };

        socket.addEventListener('message', onMessage);

        setTimeout(() => {
            socket.removeEventListener('message', onMessage);
        }, 5000);
    });
}

async function generateRayID() {
    const timestamp = Date.now();
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let randomPart = '';
    for (let i = 0; i < 10; i++) {
        randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `${timestamp}${randomPart}`;
}

export function disconnect() {
    if (socket) {
        if (socket.readyState === WebSocket.OPEN) {
            socket.close();
        }
        socket = null;
    }
    isConnected = false;
    rsaPublic = null;
    rsaPrivate = null;
    rsaPublicServer = null;
    aesKey = null;
    aesServerKey = null;
    keysReady = false;
    socketReady = false;
}