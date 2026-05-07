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

const normalize = (pre: string) =>
  pre.toLowerCase().replace(/[.,?!'"\u2019]/g, "").replace(/\s+/g, " ").trim()

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

console.log('Transcript collector ready')
