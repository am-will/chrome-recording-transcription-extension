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
let recordingActive = false

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

function visible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect()
  const style = getComputedStyle(el)
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
}

function controlLabel(el: HTMLElement): string {
  return [
    el.getAttribute('aria-label') || '',
    el.getAttribute('data-tooltip') || '',
    el.getAttribute('title') || '',
    el.textContent || '',
  ].join(' ').replace(/\s+/g, ' ').trim()
}

function dispatchClickSequence(el: HTMLElement) {
  const rect = el.getBoundingClientRect()
  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    view: window,
  }
  el.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }))
  el.dispatchEvent(new MouseEvent('mousedown', init))
  el.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }))
  el.dispatchEvent(new MouseEvent('mouseup', init))
  el.dispatchEvent(new MouseEvent('click', init))
}

function findCaptionsControl(): HTMLElement | null {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(
    [
      'button',
      '[role="button"]',
      '[aria-label*="caption" i]',
      '[aria-label*="subtitle" i]',
      '[data-tooltip*="caption" i]',
      '[data-tooltip*="subtitle" i]',
      '[title*="caption" i]',
      '[title*="subtitle" i]',
    ].join(',')
  )).filter(visible)

  const scored = candidates.flatMap((el) => {
    const selfLabel = controlLabel(el)
    const closestControl = el.closest<HTMLElement>('button,[role="button"]') || el
    const label = `${selfLabel} ${controlLabel(closestControl)}`.toLowerCase()
    if (!/\b(captions?|subtitles?)\b/.test(label)) return []
    if (/\b(turn off|disable|hide)\b.*\b(captions?|subtitles?)\b/.test(label)) return []

    let score = 1
    if (/\b(turn on|enable|show)\b.*\b(captions?|subtitles?)\b/.test(label)) score += 20
    if (/\b(captions?|subtitles?)\b.*\b(off|disabled)\b/.test(label)) score += 15
    if (closestControl !== el) score += 3
    return [{ el: closestControl, label, score }]
  })

  scored.sort((a, b) => b.score - a.score)
  return scored[0]?.el || null
}

async function captionsRegionVisible(): Promise<boolean> {
  await new Promise(resolve => setTimeout(resolve, 800))
  return !!document.querySelector('div[role="region"][aria-label="Captions"]')
}

async function enableMeetCaptions() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const captionsButton = findCaptionsControl()
    if (captionsButton) {
      console.log('[vexa-recorder] enabling captions via control:', controlLabel(captionsButton))
      dispatchClickSequence(captionsButton)
      const enabled = await captionsRegionVisible()
      return enabled
        ? { ok: true, method: 'control', label: controlLabel(captionsButton) }
        : { ok: false, error: 'Clicked captions control but captions region did not appear', label: controlLabel(captionsButton) }
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }

  const labels = Array.from(document.querySelectorAll<HTMLElement>('button,[role="button"],[aria-label],[data-tooltip],[title]'))
    .filter(visible)
    .map(controlLabel)
    .filter(Boolean)
    .slice(0, 40)
  console.log('[vexa-recorder] no captions control found. visible controls:', labels)
  return { ok: false, error: 'No visible captions control found', labels }
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
    if (msg?.type === 'ENABLE_CAPTIONS') {
      void enableMeetCaptions().then(sendResponse)
      return true
    }
    if (msg?.type === 'RECORDING_STATE') {
      recordingActive = !!msg.recording
      if (recordingActive) {
        endedSent = false
      } else {
        endedSent = false
      }
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
  if (!recordingActive) return
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

setInterval(checkForMeetReminder, 1500)
checkForMeetReminder()

window.addEventListener('pagehide', () => {
  void notifyMeetEnded('pagehide')
})

console.log('Transcript collector ready')
