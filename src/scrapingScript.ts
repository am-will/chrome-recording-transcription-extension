let transcript: string[] = []

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

const captionSelector = '.ygicle'
const speakerSelector = '.NWpY1d'
const captionParent = '.nMcdL'
let reminderEl: HTMLDivElement | null = null

const normalize = (pre: string) =>
  pre.toLowerCase().replace(/[.,?!'"\u2019]/g, "").replace(/\s+/g, " ").trim()

function meetSuffixFromLocation(): string | null {
  const match = location.pathname.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:$|[/?#])/i)
  return match?.[1] || null
}

function removeReminder() {
  reminderEl?.remove()
  reminderEl = null
}

function showRecordingReminder(suffix: string) {
  if (reminderEl) return
  const key = `vexa-recording-reminder:${suffix}`
  if (sessionStorage.getItem(key)) return
  sessionStorage.setItem(key, '1')

  reminderEl = document.createElement('div')
  reminderEl.style.cssText = [
    'position:fixed',
    'right:20px',
    'top:76px',
    'z-index:2147483647',
    'width:310px',
    'background:#fff',
    'color:#202124',
    'border:1px solid rgba(60,64,67,.22)',
    'border-radius:8px',
    'box-shadow:0 8px 28px rgba(60,64,67,.28)',
    'font:13px system-ui,-apple-system,BlinkMacSystemFont,sans-serif',
    'padding:14px',
  ].join(';')

  const title = document.createElement('div')
  title.textContent = 'Start meeting recording?'
  title.style.cssText = 'font-weight:600;font-size:14px;margin-bottom:6px'

  const detail = document.createElement('div')
  detail.textContent = 'Click the extension icon, then Start Recording. Turn captions on if you want speaker normalization.'
  detail.style.cssText = 'line-height:1.35;color:#5f6368;margin-bottom:12px'

  const actions = document.createElement('div')
  actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px'

  const dismiss = document.createElement('button')
  dismiss.type = 'button'
  dismiss.textContent = 'Dismiss'
  dismiss.style.cssText = 'border:1px solid #dadce0;background:#fff;color:#3c4043;border-radius:6px;padding:8px 10px;cursor:pointer'
  dismiss.addEventListener('click', removeReminder)

  actions.append(dismiss)
  reminderEl.append(title, detail, actions)
  document.documentElement.appendChild(reminderEl)
}

function checkForMeetReminder() {
  const suffix = meetSuffixFromLocation()
  if (suffix) showRecordingReminder(suffix)
}

function handleCaption(speakerKey: string, speakerName: string, rawText: string) {
  const text = rawText.trim()
  if (!text) return

  const norm = normalize(text)
  if (lastSeen.get(speakerKey) === norm) return
  lastSeen.set(speakerKey, norm)

  const now = Date.now()
  const existing = prior.get(speakerKey)
  if (!existing) {
    const timer = window.setTimeout(() => commit(speakerKey), CHUNK_GRACE_MS)
    prior.set(speakerKey, { startTime: now, endTime: now, speaker: speakerName, text, timer })
    return
  }

  existing.endTime = now
  existing.text = text
  existing.speaker = speakerName
  clearTimeout(existing.timer)
  existing.timer = window.setTimeout(() => commit(speakerKey), CHUNK_GRACE_MS)
}

function commit(key: string) {
  const entry = prior.get(key)
  if (!entry) return
  transcript.push(`[${new Date(entry.startTime).toISOString()}] [${new Date(entry.endTime).toISOString()}] ${entry.speaker} : ${entry.text}`.trim())
  clearTimeout(entry.timer)
  prior.delete(key)
}

function resetTranscript() {
  prior.forEach((entry) => clearTimeout(entry.timer))
  prior.clear()
  lastSeen.clear()
  transcript = []
}

function transcriptText(): string {
  ;[...prior.keys()].forEach(commit)
  return transcript.join('\n')
}

function scanCaptionNode(node: HTMLElement) {
  const txtNode = node.querySelector<HTMLDivElement>(captionSelector)
  if (!txtNode) return

  const speakerName = node.querySelector<HTMLElement>(speakerSelector)?.textContent?.trim() || 'Speaker'
  const key = node.getAttribute('data-participant-id') || speakerName
  const push = () => {
    const trimmed = txtNode.textContent?.trim() || ''
    if (trimmed) handleCaption(key, speakerName, trimmed)
  }
  push()
  new MutationObserver(push).observe(txtNode, { childList: true, subtree: true, characterData: true })
}

let captionObserver: MutationObserver | null = null

function attachCaptionObserver(region: HTMLElement) {
  captionObserver?.disconnect()
  captionObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node instanceof HTMLElement && node.matches(captionParent)) scanCaptionNode(node)
      })
    }
  })
  captionObserver.observe(region, { childList: true, subtree: true })
  region.querySelectorAll<HTMLElement>(captionParent).forEach(scanCaptionNode)
}

new MutationObserver(() => {
  const region = document.querySelector<HTMLElement>('div[role="region"][aria-label="Captions"]')
  if (region) attachCaptionObserver(region)
}).observe(document.body, { childList: true, subtree: true })

try {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'GET_TRANSCRIPT') {
      sendResponse({ transcript: transcriptText() })
      return true
    }
    if (msg?.type === 'RESET_TRANSCRIPT') {
      resetTranscript()
      sendResponse({ ok: true })
      return true
    }
    return false
  })
} catch {
  // Existing Meet tabs can retain stale content scripts after extension reload.
}

let endedSent = false

async function notifyMeetEnded(reason: string) {
  if (endedSent) return
  endedSent = true
  try {
    await chrome.runtime.sendMessage({ type: 'MEET_ENDED', reason })
  } catch {
    // Existing Meet tabs can retain stale content scripts after extension reload.
  }
}

function nodeLooksLikeLeaveControl(node: EventTarget | null): boolean {
  const el = node instanceof Element ? node.closest('button,[role="button"],div[aria-label],span[aria-label]') : null
  if (!el) return false
  const label = [
    el.getAttribute('aria-label') || '',
    el.getAttribute('data-tooltip') || '',
    el.getAttribute('title') || '',
    el.textContent || '',
  ].join(' ').toLowerCase()
  return /\b(leave call|leave meeting|end call|hang up)\b/.test(label)
}

document.addEventListener('click', (event) => {
  if (nodeLooksLikeLeaveControl(event.target)) {
    window.setTimeout(() => void notifyMeetEnded('meet_leave_control_clicked'), 500)
  }
}, true)

function looksLikePostCallScreen(): boolean {
  const bodyText = (document.body?.innerText || '').toLowerCase()
  if (/\b(you left the meeting|you've left the meeting|you left this meeting|return to home screen)\b/.test(bodyText)) return true
  return Array.from(document.querySelectorAll<HTMLElement>('button,[role="button"]')).some((el) => {
    const text = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase()
    return /\b(rejoin|join again)\b/.test(text)
  })
}

setInterval(() => {
  if (looksLikePostCallScreen()) void notifyMeetEnded('meet_post_call_screen_detected')
}, 1500)

setInterval(checkForMeetReminder, 1500)
checkForMeetReminder()

window.addEventListener('pagehide', () => {
  void notifyMeetEnded('pagehide')
})

console.log('Transcript collector ready')
