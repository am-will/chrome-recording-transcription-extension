// src/background.ts

let offscreenPort: chrome.runtime.Port | null = null
let offscreenReady = false
let lastKnownRecording = false
let activeRecording: { tabId: number; suffix: string; startedAt: number; transcriptSaved?: boolean } | null = null

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
function bglog(...a: any[]) { console.log('[background]', ...a) }
function setBadge(recording: boolean) {
  chrome.action.setBadgeText({ text: recording ? 'REC' : '' }).catch?.(() => {})
}

function clearRecordingState(reason: string) {
  activeRecording = null
  lastKnownRecording = false
  setBadge(false)
  chrome.runtime.sendMessage({ type: 'RECORDING_STATE', recording: false, reason }).catch(() => {})
}

clearRecordingState('background_loaded')

async function closeOffscreenIfIdle(): Promise<void> {
  try {
    if (await hasOffscreenContext()) {
      await chrome.offscreen.closeDocument()
    }
  } catch (e) {
    bglog('closeOffscreenIfIdle failed/non-fatal:', e)
  } finally {
    offscreenPort = null
    offscreenReady = false
  }
}

function meetSuffixFromUrl(url?: string | null): string {
  try {
    if (!url) return 'google-meet'
    const u = new URL(url)
    return u.pathname.split('/').filter(Boolean).pop() || 'google-meet'
  } catch {
    return 'google-meet'
  }
}

function artifactFilename(kind: 'recording' | 'transcript', suffix: string, startedAt: number): string {
  const ext = kind === 'recording' ? 'webm' : 'txt'
  return `vexa-meet-recordings/google-meet-${kind}-${suffix}-${startedAt}.${ext}`
}

async function pressCaptionsShortcutWithDebugger(tabId: number): Promise<{ ok: boolean; error?: string }> {
  const target = { tabId }
  try {
    await chrome.debugger.attach(target, '1.3')
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'c',
      code: 'KeyC',
      windowsVirtualKeyCode: 67,
      nativeVirtualKeyCode: 67,
    })
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'c',
      code: 'KeyC',
      windowsVirtualKeyCode: 67,
      nativeVirtualKeyCode: 67,
    })
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  } finally {
    try { await chrome.debugger.detach(target) } catch {}
  }
}

async function saveTranscriptForTab(tabId: number, suffix: string, startedAt: number): Promise<{ ok: boolean; filename?: string; error?: string }> {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'GET_TRANSCRIPT' }).catch((e) => ({ error: String(e) }))
    const transcript = (res as any)?.transcript as string | undefined
    if (!transcript?.trim()) return { ok: false, error: 'empty transcript' }

    const header = [
      `# Google Meet caption transcript`,
      `meeting_suffix: ${suffix}`,
      `recording_started_at_ms: ${startedAt}`,
      `saved_at: ${new Date().toISOString()}`,
      ``,
    ].join('\n')
    const dataUrl = `data:text/plain;charset=utf-8,${encodeURIComponent(header + transcript.trim() + '\n')}`
    const filename = artifactFilename('transcript', suffix, startedAt)
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false })
    chrome.runtime.sendMessage({ type: 'TRANSCRIPT_SAVED', filename }).catch(() => {})
    return { ok: true, filename }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

async function saveActiveTranscriptOnce(): Promise<{ ok: boolean; filename?: string; error?: string; skipped?: boolean }> {
  const rec = activeRecording
  if (!rec) return { ok: false, skipped: true, error: 'no active recording' }
  if (rec.transcriptSaved) return { ok: true, skipped: true }
  rec.transcriptSaved = true
  return await saveTranscriptForTab(rec.tabId, rec.suffix, rec.startedAt)
}

async function hasOffscreenContext(): Promise<boolean> {
  try {
    const getContexts = (chrome.runtime as any).getContexts as
      | ((q: { contextTypes: ('OFFSCREEN_DOCUMENT' | string)[] }) => Promise<any[]>)
      | undefined
    if (getContexts) {
      const ctx = await getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).catch(() => [])
      return Array.isArray(ctx) && ctx.length > 0
    }
  } catch {}
  try { return !!(await (chrome.offscreen as any).hasDocument?.()) } catch { return false }
}

async function ensureOffscreen(): Promise<void> {
  const have = await hasOffscreenContext()
  if (!have) {
    bglog('Creating offscreen document…')
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('offscreen.html'),
      reasons: ['BLOBS', 'AUDIO_PLAYBACK', 'USER_MEDIA'],
      justification: 'Record tab audio+video in offscreen using MediaRecorder'
    })
  }

  for (let i = 0; i < 10 && !(offscreenPort && offscreenReady); i++) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_PING' })
      if (res?.ok) { bglog('Offscreen responded to PING'); break }
    } catch {}
    await wait(100)
  }

  if (!(offscreenPort && offscreenReady)) {
    try { await chrome.runtime.sendMessage({ type: 'OFFSCREEN_CONNECT' }) } catch {}
  }

  for (let i = 0; i < 50; i++) {
    if (offscreenPort && offscreenReady) return
    await wait(100)
  }
  throw new Error('Offscreen did not become ready')
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'offscreen') return
  bglog('Offscreen connected')
  offscreenPort = port
  offscreenReady = false

  port.onMessage.addListener((msg: any) => {
    if (msg?.type === 'OFFSCREEN_READY') {
      offscreenReady = true
      bglog('Offscreen is READY (Port)')
    }

    if (msg?.type === 'RECORDING_STATE') {
      lastKnownRecording = !!msg.recording
      setBadge(lastKnownRecording)
      chrome.runtime.sendMessage({ type: 'RECORDING_STATE', recording: lastKnownRecording }).catch(() => {})
    }

    if (msg?.type === 'OFFSCREEN_SAVE') {
      const filename =
        (typeof msg.filename === 'string' && msg.filename.trim())
          ? msg.filename
          : `google-meet-recording-${Date.now()}.webm`

      if (msg.blobUrl) {
        bglog('Saving OFFSCREEN_SAVE via blobUrl', filename)
        const rec = activeRecording
        if (rec) {
          void saveActiveTranscriptOnce().then((result) => {
            bglog('auto saveTranscriptForTab response', result)
          })
        }
        clearRecordingState('offscreen_save_started')
        chrome.downloads.download({ url: msg.blobUrl, filename, saveAs: false }, () => {
          if (chrome.runtime.lastError) {
            bglog('downloads.download error:', chrome.runtime.lastError.message)
          } else {
            chrome.runtime.sendMessage({ type: 'RECORDING_SAVED', filename }).catch(() => {})
          }
          setTimeout(() => {
            try { offscreenPort?.postMessage({ type: 'REVOKE_BLOB_URL', blobUrl: msg.blobUrl }) } catch {}
            void closeOffscreenIfIdle()
          }, 10_000)
        })
        return
      }
    }
  })

  port.onDisconnect.addListener(() => {
    bglog('Offscreen disconnected')
    offscreenPort = null
    offscreenReady = false
    setBadge(false)
  })
})

function postToOffscreen(msg: any): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!offscreenPort) return reject(new Error('Offscreen port not connected'))
    const id = Math.random().toString(36).slice(2)
    msg.__id = id

    const listener = (m: any) => {
      if (m && m.__respFor === id) {
        offscreenPort!.onMessage.removeListener(listener)
        resolve(m.payload)
      }
    }

    offscreenPort.onMessage.addListener(listener)
    offscreenPort.postMessage(msg)

    setTimeout(() => {
      try { offscreenPort!.onMessage.removeListener(listener) } catch {}
      reject(new Error('Offscreen response timeout'))
    }, 15000)
  })
}

async function stopActiveRecording(reason: string, saveTranscript = true): Promise<{ ok: boolean; error?: string }> {
  const rec = activeRecording
  if (!rec && !lastKnownRecording) return { ok: true }

  bglog('Stopping active recording:', reason)
  if (rec && saveTranscript) {
    const transcript = await saveActiveTranscriptOnce()
    bglog('saveTranscriptForTab response', transcript)
  }

  try {
    await ensureOffscreen()
    if (offscreenPort) {
      const r = await postToOffscreen({ type: 'OFFSCREEN_STOP', reason })
      bglog('postToOffscreen(OFFSCREEN_STOP) response', r)
      if (r?.ok === false && !/not currently recording/i.test(String(r.error || ''))) {
        return { ok: false, error: r.error || 'Failed to stop' }
      }
    }
  } finally {
    clearRecordingState(reason)
    await closeOffscreenIfIdle()
  }
  return { ok: true }
}

// background side streamId helper
type CaptureSource = 'tab' | 'desktop'
type CaptureStream = { streamId: string; source: CaptureSource }

function getStreamIdForTab(tabId: number): Promise<CaptureStream> {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id?: string) => {
        const err = chrome.runtime.lastError
        if (err) return reject(new Error(err.message))
        if (!id) return reject(new Error('Empty streamId'))
        resolve({ streamId: id, source: 'tab' })
      })
    } catch (e) {
      reject(e as any)
    }
  })
}

function chooseDesktopStreamForTab(tabId: number): Promise<CaptureStream> {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      const targetTab = chrome.runtime.lastError ? undefined : tab
      try {
        const callback = (streamId: string) => {
          const err = chrome.runtime.lastError
          if (err) return reject(new Error(err.message))
          if (!streamId) return reject(new Error('Capture picker was cancelled'))
          resolve({ streamId, source: 'desktop' })
        }
        if (targetTab) {
          chrome.desktopCapture.chooseDesktopMedia(['tab', 'audio'], targetTab, callback)
        } else {
          ;(chrome.desktopCapture.chooseDesktopMedia as any)(['tab', 'audio'], callback)
        }
      } catch (e) {
        reject(e as any)
      }
    })
  })
}

async function getStreamIdForRecording(tabId: number): Promise<CaptureStream> {
  try {
    return await getStreamIdForTab(tabId)
  } catch (e: any) {
    const message = e?.message || String(e)
    bglog('tabCapture.getMediaStreamId failed; falling back to desktopCapture:', message)
    if (!/not been invoked|activeTab|current page/i.test(message)) {
      throw e
    }
    return await chooseDesktopStreamForTab(tabId)
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'START_RECORDING') {
      const tabId: number | undefined = msg.tabId ?? _sender.tab?.id
      if (typeof tabId !== 'number') { sendResponse({ ok: false, error: 'Missing tabId' }); return }
      bglog('Requested START_RECORDING for tabId', tabId)

      try {
        await ensureOffscreen()
        bglog('ensureOffscreen() completed')
      } catch (e: any) {
        sendResponse({ ok: false, error: `Offscreen not ready: ${e?.message || e}` })
        return
      }

      try {
        const tab = await chrome.tabs.get(tabId).catch(() => undefined)
        const suffix = typeof msg.suffix === 'string' && msg.suffix.trim()
          ? msg.suffix.trim()
          : meetSuffixFromUrl(tab?.url)
        const startedAt = typeof msg.startedAt === 'number' ? msg.startedAt : Date.now()
        await chrome.tabs.sendMessage(tabId, { type: 'RESET_TRANSCRIPT' }).catch(() => {})
        const capture = await getStreamIdForRecording(tabId)
        const r = await postToOffscreen({
          type: 'OFFSCREEN_START',
          streamId: capture.streamId,
          captureSource: capture.source,
          suffix,
          startedAt,
          filename: artifactFilename('recording', suffix, startedAt),
        })
        bglog('postToOffscreen(OFFSCREEN_START) response', r)

        if (r?.ok) {
          lastKnownRecording = true
          activeRecording = { tabId, suffix, startedAt, transcriptSaved: false }
          setBadge(true)
          chrome.runtime.sendMessage({ type: 'RECORDING_STATE', recording: true, suffix, startedAt }).catch(() => {})
          chrome.tabs.sendMessage(tabId, { type: 'RECORDING_STATE', recording: true, suffix, startedAt }).catch(() => {})
          sendResponse({ ok: true, suffix, startedAt })
        } else {
          sendResponse({ ok: false, error: r?.error || 'Failed to start' })
        }
      } catch (e: any) {
        bglog('OFFSCREEN_START failed', e)
        sendResponse({ ok: false, error: `OFFSCREEN_START failed: ${e?.message || e}` })
      }
      return
    }

    if (msg?.type === 'STOP_RECORDING') {
      try {
        sendResponse(await stopActiveRecording(msg.reason || 'manual_stop'))
      } catch (e: any) {
        sendResponse({ ok: false, error: `STOP failed: ${e?.message || e}` })
      }
      return
    }

    if (msg?.type === 'GET_RECORDING_STATUS') {
      sendResponse({ recording: lastKnownRecording, activeRecording })
      return
    }

    if (msg?.type === 'ENABLE_CAPTIONS_DEBUGGER') {
      const tabId: number | undefined = msg.tabId ?? _sender.tab?.id ?? activeRecording?.tabId
      if (typeof tabId !== 'number') { sendResponse({ ok: false, error: 'Missing tabId' }); return }
      sendResponse(await pressCaptionsShortcutWithDebugger(tabId))
      return
    }

    if (msg?.type === 'SAVE_TRANSCRIPT') {
      const tabId: number | undefined = msg.tabId ?? _sender.tab?.id ?? activeRecording?.tabId
      const suffix = String(msg.suffix || activeRecording?.suffix || 'google-meet')
      const startedAt = Number(msg.startedAt || activeRecording?.startedAt || Date.now())
      if (typeof tabId !== 'number') { sendResponse({ ok: false, error: 'Missing tabId' }); return }
      sendResponse(await saveTranscriptForTab(tabId, suffix, startedAt))
      return
    }

    if (msg?.type === 'MEET_ENDED') {
      if (_sender.tab?.id && activeRecording?.tabId === _sender.tab.id) {
        sendResponse(await stopActiveRecording(msg.reason || 'meet_ended'))
      } else {
        sendResponse({ ok: true, ignored: true })
      }
      return
    }
  })().catch((err) => {
    console.error('[background] top-level error', err)
    sendResponse({ ok: false, error: String(err) })
  })

  return true
})

chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeRecording?.tabId === tabId) {
    void stopActiveRecording('recorded_tab_removed', false)
  }
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (activeRecording?.tabId !== tabId) return
  const nextUrl = changeInfo.url || tab.url || ''
  if (nextUrl && !/^https:\/\/meet\.google\.com\//i.test(nextUrl)) {
    void stopActiveRecording('recorded_tab_left_meet')
  }
})

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  if (activeRecording?.tabId === removedTabId) {
    activeRecording.tabId = addedTabId
  }
})

chrome.runtime.onSuspend?.addListener(async () => {
  try { await stopActiveRecording('background_suspend', false) } catch {}
})
