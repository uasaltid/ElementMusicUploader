import { parseFile } from "music-metadata"
import readline from 'readline'
import fs from 'fs/promises'
import { connect, send } from './api/index.js'

let rl = readline.promises.createInterface(process.stdin, process.stdout)

const delay = 31
const args = process.argv.slice(2)
const inputDir = (args?.[0] ? args[0] : undefined) || await rl.question("Input dir: ")

async function exists(path) {
    try {
        await fs.access(path)
        return true
    } catch {
        return false
    }
}

if (await exists(".env") && Object.keys(process.env) < 1) {
    let envFile = await fs.readFile('.env', { encoding: 'utf-8' })
    for (const line of envFile.split("\n")) {
        const [k, v] = line.split('=')
        process.env[k] = v
    } 
}

await connect()
async function auth() {
    if (process.env?.session) {
        const { status, message } = await send({
            type: 'authorization',
            action: 'connect',
            S_KEY: process.env.session
        })

        if (status == 'error') {
            console.log('Authorization error: ' + message)
            delete process.env.session
            await auth()
        }
    } else {
        const { status, message, S_KEY } = await send({
            type: 'social',
            action: 'auth/login',
            email: (args?.[1] ? args[1] : undefined) || await rl.question("email: "),
            password: (args?.[2] ? args[2] : undefined) || await rl.question("password: "),
            device: 'Element music | uasalt'
        })

        if (status == 'error') {
            console.log('Login error: ' + message)
            await auth()
        } else {
            await fs.writeFile('.env', `session=${S_KEY}`)
        }
    }
}

await auth()

async function search(title) {
    const { status, message, results } = await send({
        type: "social",
        action: "search",
        category: 'music',
        start_index: 0,
        value: title
    })

    if (status == 'error') {
        console.log("Exists check error: " + message)
        return true
    }

    if (results > 0) return true
    return false
}

let proccessedTracks = 0
const dirContents = await fs.readdir(inputDir, { withFileTypes: true })

function calculateETA(tracks) {
  let totalSeconds = tracks * delay;
  
  if (totalSeconds < 60) {
    return `${totalSeconds} second${totalSeconds === 1 ? '' : 's'}`;
  }

  let totalMinutes = totalSeconds / 60;
  if (totalMinutes < 60) {
    const minutes = Math.floor(totalMinutes);
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }

  let totalHours = totalMinutes / 60;
  if (totalHours < 24) {
    const hours = Math.floor(totalHours);
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }

  let totalDays = totalHours / 24;
  const days = Math.floor(totalDays);
  return `${days} day${days === 1 ? '' : 's'}`;
}

for (const content of dirContents) {
    if (!content.isFile()) continue
    const realPath = `${inputDir}/${content.name}`
    const { common: payload } = await parseFile(realPath)

    if (!payload?.title || !payload?.artist) continue
    if (search(payload.title)) {
        console.log(`${payload.artist} - ${payload.title} already exists`)
        continue
    }
    console.log(`${payload.artist} - ${payload.title} uploading`)
    
    payload.audio_file = await fs.readFile(realPath)
    if (payload?.picture?.length > 0) {
        let cover = payload.picture.shift()
        payload.cover_file = Buffer.from(cover.data)
        delete payload.picture
    }

    const { status, message } = await send({
        type: 'social',
        action: 'music/upload',
        payload
    })

    if (status == 'error') {
        console.log('Upload error: ' + message)
        continue
    }
    
    proccessedTracks++
    console.log(`${payload.artist} - ${payload.title} uploaded ${proccessedTracks}/${totalTracs}`)
    console.log(`ETA: ${calculateETA(proccessedTracks)}. Waiting ${delay} seconds...`)
    await new Promise(r=>setTimeout(r, delay * 1000))
}

console.log("Done.")