let transcript: string[] = []
let promptEl: HTMLDivElement | null = null
let stopEl: HTMLButtonElement | null = null
let currentRecording: { suffix: string; startedAt: number } | null = null

interface Chunk {
  startTime: number
  endTime: number
  speaker: string
  text: string
}
type OpenChunk = Chunk & { timer: number }

const CHUNK_GRACE_MS = 2000

const prior = new Map<string, OpenChunk>()
const lastSeen = new Map<string, string>()

const normalize = (pre: string) =>
  pre.toLowerCase().replace(/[.,?!'"\u2019]/g, "").replace(/\s+/g, " ").trim()

function meetSuffixFromLocation(): string | null {
  const match = location.pathname.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:$|[/?#])/i)
  return match?.[1] || null
}

function handleCaption(speakerKey: string, speakerName: string, rawText: string){
  const text = rawText.trim()
  if(!text) return

  const norm = normalize(text)
  const prev = lastSeen.get(speakerKey)
  if (prev === norm) return
  lastSeen.set(speakerKey, norm)

  const now = Date.now()
  const existing = prior.get(speakerKey)

  if (!existing){
    const timer = window.setTimeout(() => commit(speakerKey), CHUNK_GRACE_MS)
    prior.set(speakerKey, {
      startTime: now,
      endTime: now,
      speaker: speakerName,
      text,
      timer
    })
    return
  }

  existing.endTime = now
  existing.text = text
  existing.speaker = speakerName

  clearTimeout(existing.timer)
  existing.timer = window.setTimeout(() => commit(speakerKey), CHUNK_GRACE_MS)
}

function commit(key: string){
  const entry = prior.get(key)
  if(!entry) return

  const startTS = new Date(entry.startTime).toISOString()
  const endTS = new Date(entry.endTime).toISOString()
  transcript.push(`[${startTS}] [${endTS}] ${entry.speaker} : ${entry.text}`.trim())
  clearTimeout(entry.timer)
  prior.delete(key)
}

let captionSelector = '.ygicle'
let speakerSelector = '.NWpY1d'
let captionParent  = '.nMcdL'

let captionObserver: MutationObserver | null = null

function scanClasses(cl: HTMLElement){
  const txtNode = cl.querySelector<HTMLDivElement>(captionSelector)
  if(!txtNode) return

  const speakerName = cl.querySelector<HTMLElement>(speakerSelector)?.textContent?.trim() ?? ' '
  const key = cl.getAttribute('data-participant-id') || speakerName

  const push = () => {
    const trimmed = txtNode.textContent?.trim() ?? ''
    if(trimmed) handleCaption(key, speakerName, trimmed)
  }

  push()

  new MutationObserver(push).observe(txtNode, { childList: true, subtree: true, characterData: true })
}

function launchAttachObserver(region: HTMLElement) {
  captionObserver?.disconnect()

  captionObserver = new MutationObserver((mutations) => {
    mutations.forEach(mutation => {
      mutation.addedNodes.forEach(node => {
        if (node instanceof HTMLElement && node.matches(captionParent)) {
          scanClasses(node)
        }
      })
    })
  })

  captionObserver.observe(region, { childList: true, subtree: true })
  console.log(`Caption observer attached`)
  region.querySelectorAll<HTMLElement>(captionParent).forEach(scanClasses)
}

new MutationObserver(() => {
  const region = document.querySelector<HTMLElement>('div[role="region"][aria-label="Captions"]')
  if(region){
    launchAttachObserver(region)
  }
}).observe(document.body, { childList: true, subtree: true })

;(window as any).getTranscript = () => {
    [...prior.keys()].forEach(commit)
    return transcript.join("\n")
  }
  
  ;(window as any).resetTranscript = () => {
    prior.clear()
    transcript.length = 0
  }
  
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'GET_TRANSCRIPT') {
      ;[...prior.keys()].forEach(commit)
      sendResponse({ transcript: transcript.join('\n') })
      return true
    }
    if (msg?.type === 'RESET_TRANSCRIPT') {
      prior.clear()
      transcript.length = 0
      sendResponse({ ok: true })
      return true
    }
  })

function removePrompt() {
  promptEl?.remove()
  promptEl = null
}

function ensureStopButton() {
  if (stopEl) return
  stopEl = document.createElement('button')
  stopEl.textContent = 'Stop recording'
  stopEl.setAttribute('type', 'button')
  stopEl.style.cssText = [
    'position:fixed',
    'right:20px',
    'bottom:20px',
    'z-index:2147483647',
    'background:#b3261e',
    'color:#fff',
    'border:0',
    'border-radius:6px',
    'font:500 13px system-ui,-apple-system,BlinkMacSystemFont,sans-serif',
    'padding:10px 12px',
    'box-shadow:0 4px 14px rgba(0,0,0,.25)',
    'cursor:pointer',
  ].join(';')
  stopEl.addEventListener('click', async () => {
    stopEl!.disabled = true
    stopEl!.textContent = 'Stopping...'
    await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }).catch((e) => ({ ok: false, error: String(e) }))
    currentRecording = null
    stopEl?.remove()
    stopEl = null
  })
  document.documentElement.appendChild(stopEl)
}

function showRecordingPrompt(suffix: string) {
  if (promptEl || currentRecording) return
  const promptKey = `vexa-recording-prompted:${suffix}`
  if (sessionStorage.getItem(promptKey)) return
  sessionStorage.setItem(promptKey, '1')

  promptEl = document.createElement('div')
  promptEl.style.cssText = [
    'position:fixed',
    'right:20px',
    'top:76px',
    'z-index:2147483647',
    'width:300px',
    'background:#fff',
    'color:#202124',
    'border:1px solid rgba(60,64,67,.22)',
    'border-radius:8px',
    'box-shadow:0 8px 28px rgba(60,64,67,.28)',
    'font:13px system-ui,-apple-system,BlinkMacSystemFont,sans-serif',
    'padding:14px',
  ].join(';')

  const title = document.createElement('div')
  title.textContent = 'Record this Google Meet?'
  title.style.cssText = 'font-weight:600;font-size:14px;margin-bottom:6px'
  const detail = document.createElement('div')
  detail.textContent = 'The extension will save a local recording and captions for Vexa notes. Turn on Meet captions for speaker normalization.'
  detail.style.cssText = 'line-height:1.35;color:#5f6368;margin-bottom:12px'

  const actions = document.createElement('div')
  actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px'
  const no = document.createElement('button')
  no.textContent = 'Not now'
  no.type = 'button'
  no.style.cssText = 'border:1px solid #dadce0;background:#fff;color:#3c4043;border-radius:6px;padding:8px 10px;cursor:pointer'
  no.addEventListener('click', removePrompt)

  const yes = document.createElement('button')
  yes.textContent = 'Record'
  yes.type = 'button'
  yes.style.cssText = 'border:0;background:#1a73e8;color:#fff;border-radius:6px;padding:8px 12px;cursor:pointer'
  yes.addEventListener('click', async () => {
    yes.disabled = true
    no.disabled = true
    yes.textContent = 'Starting...'
    const startedAt = Date.now()
    ;(window as any).resetTranscript()
    const resp = await chrome.runtime.sendMessage({ type: 'START_RECORDING', suffix, startedAt }).catch((e) => ({ ok: false, error: String(e) }))
    if ((resp as any)?.ok) {
      currentRecording = { suffix, startedAt }
      removePrompt()
      ensureStopButton()
    } else {
      yes.disabled = false
      no.disabled = false
      yes.textContent = 'Record'
      detail.textContent = `Could not start recording: ${(resp as any)?.error || 'unknown error'}`
    }
  })

  actions.append(no, yes)
  promptEl.append(title, detail, actions)
  document.documentElement.appendChild(promptEl)
}

function checkForMeet() {
  const suffix = meetSuffixFromLocation()
  if (suffix) showRecordingPrompt(suffix)
}

setInterval(checkForMeet, 1500)
checkForMeet()

window.addEventListener('pagehide', () => {
  if (currentRecording) {
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }).catch(() => {})
  }
})

console.log('Transcript collector ready')
