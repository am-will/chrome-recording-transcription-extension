// src/offscreen.ts

// Flip this on to include your local mic in the recording mix.
// NOTE: Offscreen cannot show the initial mic permission prompt.
// You must "prime" mic permission once from a visible page (popup/options/extension tab)
// via navigator.mediaDevices.getUserMedia({ audio: true }) before this will succeed.
const WANT_MIC_MIX = true
const AUDIO_ONLY_RECORDING = true

window.addEventListener('error', (e) => {
  console.error('[offscreen] window.onerror', e?.message, e?.error)
})
window.addEventListener('unhandledrejection', (e: any) => {
  console.error('[offscreen] unhandledrejection', e?.reason || e)
})
console.log('[offscreen] script loaded')

// port plumbing
let portRef: chrome.runtime.Port | null = null
function log(...a: any[]) { console.log('[offscreen]', ...a) }

function connectPort(): chrome.runtime.Port {
  try { portRef?.disconnect() } catch {}
  const p: chrome.runtime.Port = chrome.runtime.connect({ name: 'offscreen' })
  p.onDisconnect.addListener(() => { log('Port disconnected'); portRef = null })
  // tell background alive
  p.postMessage({ type: 'OFFSCREEN_READY' })
  log('READY signaled via Port')
  portRef = p
  return p
}
function getPort(): chrome.runtime.Port { return portRef ?? connectPort() }
function respond(req: any, payload: any) { getPort().postMessage({ __respFor: req?.__id, payload }) }

// popup uses this to flip buttons
function pushState(recording: boolean, extra?: Record<string, any>) {
  try { (chrome.storage as any)?.session?.set?.({ recording }).catch?.(() => {}) } catch {}
  getPort().postMessage({ type: 'RECORDING_STATE', recording, ...extra })
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms))

function inferSuffixFromActiveTabUrl(url?: string | null): string {
  try {
    if (!url) return 'google-meet'
    const u = new URL(url)
    const last = u.pathname.split('/').pop() || 'google-meet'
    return last
  } catch { return 'google-meet' }
}

// simple 1-channel RMS meter for debugging
function attachRmsMeter(track: MediaStreamTrack, label: 'RAW' | 'FINAL') {
  try {
    const ctx = createAudioContext()
    const src = ctx.createMediaStreamSource(new MediaStream([track]))
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    const buf = new Uint8Array(analyser.frequencyBinCount)
    src.connect(analyser)
    const id = setInterval(() => {
      analyser.getByteTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) {
        const x = (buf[i] - 128) / 128
        sum += x * x
      }
      const rms = Math.sqrt(sum / buf.length)
      console.log('[offscreen]', `${label} input level (rms):`, rms.toFixed(3))
    }, 1000)
    track.addEventListener('ended', () => { try { clearInterval(id) } catch {} })
  } catch (e) {
    log('meter setup failed (non-fatal)', e)
  }
}

// record & mix
async function maybeGetMicStream(): Promise<MediaStream | null> {
  if (!WANT_MIC_MIX) return null
  try {
    // only succeeds if mic permission was previously granted to the extension origin
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
    const t = mic.getAudioTracks()[0]
    log('mic stream acquired:', !!t, 'muted:', t?.muted, 'enabled:', t?.enabled)
    return mic
  } catch (e) {
    log('mic getUserMedia failed (continuing without mic):', e)
    return null
  }
}

function mixAudio(tabStream: MediaStream, micStream: MediaStream | null): MediaStream {
  const tabAudio = tabStream.getAudioTracks()[0]
  if (!micStream || !tabAudio) return tabStream

  const ctx = createAudioContext()
  const dst = ctx.createMediaStreamDestination()

  try {
    const tabSource = ctx.createMediaStreamSource(new MediaStream([tabAudio]))
    tabSource.connect(dst)
  } catch (err) {
    log('tab source connect failed for mixing; using tab audio only', err)
    return tabStream
  }

  try {
    const micTrack = micStream.getAudioTracks()[0]
    if (micTrack) {
      const micSource = ctx.createMediaStreamSource(new MediaStream([micTrack]))
      micSource.connect(dst)
    }
  } catch (e) {
    log('mic source connect failed; continuing with tab audio only', e)
  }

  const final = new MediaStream([
    ...(AUDIO_ONLY_RECORDING ? [] : tabStream.getVideoTracks()),
    ...dst.stream.getAudioTracks()
  ])

  // DO NOT stop tabAudio here!!! stopping will kill the upstream source
  return final
}

function makeConstraints(streamId: string, source: 'tab' | 'desktop'): MediaStreamConstraints {
  const mandatory = { chromeMediaSource: source, chromeMediaSourceId: streamId } as any
  return {
    audio: {
      mandatory,
      optional: [{ googDisableLocalEcho: false }]
    } as any,
    video: AUDIO_ONLY_RECORDING ? false : ({
      mandatory: {
        ...mandatory,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 30
      }
    } as any)
  }
}

async function captureWithStreamId(streamId: string, source: 'tab' | 'desktop'): Promise<MediaStream> {
  log(`Attempting getUserMedia with streamId ${streamId} source=${source} mode=${AUDIO_ONLY_RECORDING ? 'audio-only' : 'audio-video'}`)
  return await navigator.mediaDevices.getUserMedia(makeConstraints(streamId, source))
}

let mediaRecorder: MediaRecorder | null = null
let chunks: BlobPart[] = []
let capturing = false
let currentFilename = ''
let activeStreams: MediaStream[] = []
let activeAudioContexts: AudioContext[] = []
let stopCompletion: Promise<void> | null = null
let resolveStopCompletion: (() => void) | null = null
let rejectStopCompletion: ((error: Error) => void) | null = null

function createAudioContext(): AudioContext {
  const AC = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext
  const ctx = new AC()
  activeAudioContexts.push(ctx)
  void ctx.resume().catch(() => {})
  return ctx
}

function releaseActiveStreams() {
  for (const stream of activeStreams) {
    try { stream.getTracks().forEach(t => t.stop()) } catch {}
  }
  activeStreams = []
  for (const ctx of activeAudioContexts) {
    try { void ctx.close().catch(() => {}) } catch {}
  }
  activeAudioContexts = []
}

function monitorTabAudio(tabStream: MediaStream) {
  const tabAudio = tabStream.getAudioTracks()[0]
  if (!tabAudio) return
  try {
    const ctx = createAudioContext()
    const source = ctx.createMediaStreamSource(new MediaStream([tabAudio]))
    source.connect(ctx.destination)
    log('tab audio monitor connected to local output')
  } catch (e) {
    log('tab audio monitor setup failed; recording can continue but local playback may be muted', e)
  }
}

async function prepareAndRecord(baseStream: MediaStream, requestedFilename?: string): Promise<void> {
  const a = baseStream.getAudioTracks()
  const v = baseStream.getVideoTracks()
  log('getUserMedia() tracks:', {
    audioCount: a.length,
    videoCount: v.length,
    audioMuted: a[0]?.muted,
    audioEnabled: a[0]?.enabled
  })
  a.forEach((t) => { try { t.enabled = true } catch {} })

  if (!a.length) {
    pushState(false, { warning: 'NO_TAB_AUDIO' })
  } else {
    const T = a[0]
    console.log('[offscreen] audio track settings:', T?.getSettings?.())
    console.log('[offscreen] audio track muted/enabled:', T?.muted, T?.enabled)
    T?.addEventListener('mute', () => console.log('[offscreen] track MUTED'))
    T?.addEventListener('unmute', () => console.log('[offscreen] track UNMUTED'))
  }
  if (!AUDIO_ONLY_RECORDING && !v.length) throw new Error('No video track in captured stream')

  // debug meters
  const rawAudio = baseStream.getAudioTracks()[0]
  if (rawAudio) attachRmsMeter(rawAudio, 'RAW')
  monitorTabAudio(baseStream)

  const micStream = await maybeGetMicStream()
  const mixedStream = mixAudio(baseStream, micStream)
  activeStreams = [baseStream, ...(micStream ? [micStream] : []), mixedStream]

  const finalAudio = mixedStream.getAudioTracks()[0]
  if (finalAudio) attachRmsMeter(finalAudio, 'FINAL')
  if (!finalAudio) log('WARNING: final stream has NO audio track — recording will be silent')

  log('final stream tracks -> video:', mixedStream.getVideoTracks().length, 'audio:', mixedStream.getAudioTracks().length)

  // safety check, not fatal
  if (rawAudio) {
    try {
      const ctx = createAudioContext()
      await ctx.resume().catch(() => {})
      const src = ctx.createMediaStreamSource(new MediaStream([rawAudio]))
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      const buf = new Uint8Array(analyser.frequencyBinCount)
      src.connect(analyser)
      await sleep(1000)
      analyser.getByteTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) {
        const x = (buf[i] - 128) / 128
        sum += x * x
      }
      const rms = Math.sqrt(sum / buf.length)
      if (rms < 0.005) log('no audio energy detected before start')
      try { await ctx.close() } catch {}
      activeAudioContexts = activeAudioContexts.filter(activeCtx => activeCtx !== ctx)
    } catch {}
  }

  chunks = []
  stopCompletion = new Promise<void>((resolve, reject) => {
    resolveStopCompletion = resolve
    rejectStopCompletion = reject
  })
  const mime = AUDIO_ONLY_RECORDING && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
    ? 'video/webm;codecs=vp8,opus'
    : 'video/webm'

  mediaRecorder = new MediaRecorder(mixedStream, {
    mimeType: mime,
    audioBitsPerSecond: 128_000
  })

  const started = new Promise<void>((resolve, reject) => {
    const startTimeout = setTimeout(() => reject(new Error('MediaRecorder did not start (timeout)')), 4000)

    mediaRecorder!.onstart = () => {
      clearTimeout(startTimeout)
      capturing = true
      pushState(true)
      log('MediaRecorder started')
      resolve()
    }

    mediaRecorder!.onerror = (e: any) => {
      clearTimeout(startTimeout)
      log('MediaRecorder error', e)
      releaseActiveStreams()
      mediaRecorder = null
      capturing = false
      pushState(false)
      const error = new Error(e?.name || 'MediaRecorder error')
      rejectStopCompletion?.(error)
      reject(error)
    }

    mediaRecorder!.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size) chunks.push(e.data)
    }

    mediaRecorder!.onstop = async () => {
      try {
        const blob = new Blob(chunks, { type: mime })
        log('Finalizing; chunks =', chunks.length, 'blob.size =', blob.size)

        // filename suffix
        let suffix = 'google-meet'
        try {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
          suffix = inferSuffixFromActiveTabUrl(tabs[0]?.url || null)
        } catch {}

        const filename = currentFilename || requestedFilename || `google-meet-recording-${suffix}-${Date.now()}.webm`
        const blobUrl = URL.createObjectURL(blob)
        getPort().postMessage({ type: 'OFFSCREEN_SAVE', filename, blobUrl })
      } catch (e) {
        log('Finalize/Save failed', e)
      } finally {
        releaseActiveStreams()
        mediaRecorder = null
        chunks = []
        currentFilename = ''
        capturing = false
        pushState(false)
        resolveStopCompletion?.()
        stopCompletion = null
        resolveStopCompletion = null
        rejectStopCompletion = null
      }
    }
  })

  mediaRecorder.start(1000)

  // If the captured tab stream ends, auto-stop.
  mixedStream.getTracks()[0]?.addEventListener('ended', () => {
    log('Captured track ended')
    if (mediaRecorder && capturing) { try { mediaRecorder.stop() } catch {} }
  })

  await started
}

async function startRecordingFromStreamId(streamId: string, source: 'tab' | 'desktop'): Promise<void> {
  if (capturing) { log('Already recording; ignoring start'); return }
  const baseStream = await captureWithStreamId(streamId, source)
  await prepareAndRecord(baseStream, currentFilename)
}

async function stopRecording() {
  if (!mediaRecorder || !capturing) {
    console.warn('[offscreen] Stop called but not recording')
    releaseActiveStreams()
    throw new Error('Not currently recording')
  }
  try { mediaRecorder.stop() } catch (e) { console.error('[offscreen] Stop error', e); throw e }
  await (stopCompletion || Promise.resolve())
}

// port rpc
const rpcPort = getPort()
rpcPort.onMessage.addListener(async (msg: any) => {
  try {
    if (msg?.type === 'OFFSCREEN_START') {
      const streamId = msg.streamId as string | undefined
      if (!streamId) return respond(msg, { ok: false, error: 'Missing streamId' })
      try {
        currentFilename = typeof msg.filename === 'string' ? msg.filename : ''
        const source = msg.captureSource === 'desktop' ? 'desktop' : 'tab'
        // wait until actually starts
        await startRecordingFromStreamId(streamId, source)
        return respond(msg, { ok: true })
      } catch (e: any) {
        return respond(msg, { ok: false, error: `${e?.name || 'Error'}: ${e?.message || e}` })
      }
    }

    if (msg?.type === 'OFFSCREEN_START_TAB') {
      // background must provide streamId
      return respond(msg, { ok: false, error: 'Use OFFSCREEN_START with streamId from background' })
    }

    if (msg?.type === 'OFFSCREEN_STOP') {
      try { await stopRecording(); return respond(msg, { ok: true }) }
      catch (e) { return respond(msg, { ok: false, error: String(e) }) }
    }

    if (msg?.type === 'OFFSCREEN_STATUS') {
      let recording = false
      try {
        const res = await (chrome.storage as any)?.session?.get?.(['recording'])
        recording = !!res?.recording
      } catch {}
      return respond(msg, { recording })
    }

    if (msg?.type === 'DIAG_ECHO') {
      return respond(msg, { ok: true, pong: 'offscreen-alive' })
    }

    if (msg?.type === 'REVOKE_BLOB_URL' && typeof msg.blobUrl === 'string') {
      try { URL.revokeObjectURL(msg.blobUrl) } catch {}
      return
    }
  } catch (e) {
    console.error('[offscreen] error', e)
    respond(msg, { ok: false, error: String(e) })
  }
})

// allow background to check before port is ready
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  try {
    if (msg?.type === 'OFFSCREEN_PING') { sendResponse({ ok: true, via: 'onMessage' }); return true }
    if (msg?.type === 'OFFSCREEN_CONNECT') { connectPort(); sendResponse({ ok: true }); return true }
  } catch (e) { sendResponse({ ok: false, error: String(e) }) }
  return false
})
