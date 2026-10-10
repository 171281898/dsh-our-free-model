/**
 * Candidate ordering and the advance policy for the model router.
 *
 * Three independent decisions meet in this module, and keeping them apart is
 * what makes the router testable without a network:
 *
 * 1. *Which candidates, in which order* — `buildChain` folds the primary and
 *    its fallbacks into one deduplicated list and resolves catalog metadata,
 *    `rotationOrder` applies the combo's strategy (fixed fallback order, or
 *    round-robin with a sticky count), and `reorderByCapabilities` floats the
 *    candidates that can actually carry the request's modalities to the front.
 *    The capability reorder is a *stable sort and never drops a candidate*:
 *    ordering is a preference, not a filter, or a request that needs vision
 *    would lose its text-only fallbacks entirely.
 * 2. *Where the request's modalities come from* — `detectRequiredCapabilities`
 *    scans the trailing user turn only. History media (an image three turns
 *    ago) must not pin the whole conversation to a vision model, because the
 *    adapter already strips and placeholders old media; only what the current
 *    turn carries decides which candidate can serve it.
 * 3. *Whether a failed turn may move to the next provider at all* —
 *    `assessRecovery` ports FCC's RESTART/CONTINUE/HANDOFF/STOP assessment. A
 *    failed candidate may be retried from scratch only when nothing reached the
 *    client; once text has been released, the next provider must continue that
 *    exact prefix rather than restart (or the user sees the answer twice), and
 *    once a completed tool call has been released the client already owns the
 *    call, so the router may only hand off.
 *
 * The one piece of state is the round-robin rotation map. It is accepted as a
 * parameter on every call so tests can inject a fresh one, and the module-level
 * map is only the default a real caller gets; nothing else here is stateful,
 * time-dependent or random.
 *
 * @module src/route/chain.js
 */

/**
 * Capabilities that change what the request *means*: a model without one drops
 * input data (an image is stripped), so satisfying them is a hard requirement.
 * Soft capabilities (search, and anything a caller invents) only degrade a
 * feature, so they rank below the hard ones. The names match 9router's
 * capability table, which is also what `detectRequiredCapabilities` returns.
 */
const HARD_CAPABILITIES = Object.freeze(['vision', 'pdf', 'audioInput', 'videoInput'])

/** Rotation key for a caller that names no combo. */
const DEFAULT_COMBO = '__default__'

/** The rotation map a real caller gets when it does not inject one. */
const ROTATION_STATE = new Map()

/** Normalize "array | single | nothing" into an array, without copying arrays. */
function listOf(value) {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

/** A non-empty trimmed string, or undefined. */
function nonEmptyString(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** The model id of a candidate-shaped value, or ''. */
function modelIdOf(value) {
  if (value === null || typeof value !== 'object') return ''
  return nonEmptyString(value.modelId) ?? nonEmptyString(value.id) ?? ''
}

/** Normalize one chain input (string or candidate object) into `{modelId, provider?, entry?}`. */
function toCandidate(raw) {
  if (typeof raw === 'string') {
    const modelId = raw.trim()
    return modelId === '' ? null : { modelId }
  }
  if (raw === null || typeof raw !== 'object') return null
  const modelId = modelIdOf(raw)
  if (modelId === '') return null
  const candidate = { modelId }
  const provider = nonEmptyString(raw.provider)
  if (provider !== undefined) candidate.provider = provider
  if (raw.entry !== null && typeof raw.entry === 'object') candidate.entry = raw.entry
  return candidate
}

/** Catalog entries by id; a Map may be handed in instead of an array. */
function catalogIndex(catalog) {
  if (catalog instanceof Map) return catalog
  const index = new Map()
  for (const entry of listOf(catalog)) {
    if (entry === null || typeof entry !== 'object') continue
    const id = nonEmptyString(entry.id)
    if (id !== undefined && !index.has(id)) index.set(id, entry)
  }
  return index
}

/**
 * Look up one candidate's catalog entry. A composite candidate (`provider`
 * plus an id that already starts with `provider/`) is read back to its bare
 * model id, because that is what both the free lane's catalog and the
 * aggregate registry key their entries by.
 */
function entryFor(index, candidate) {
  const direct = index.get(candidate.modelId)
  if (direct !== undefined) return direct
  if (candidate.provider !== undefined && candidate.modelId.startsWith(`${candidate.provider}/`)) {
    return index.get(candidate.modelId.slice(candidate.provider.length + 1))
  }
  return undefined
}

/** The lookup keys a capability table may be keyed by, most specific first. */
function capabilityKeys(candidate, entry) {
  const keys = []
  if (candidate.provider !== undefined) keys.push(`${candidate.provider}/${candidate.modelId}`)
  keys.push(candidate.modelId)
  const entryId = nonEmptyString(entry?.id)
  if (entryId !== undefined && !keys.includes(entryId)) keys.push(entryId)
  return keys
}

/**
 * Resolve one candidate's capability flags from the table `buildChain` was
 * handed: a plain object map keyed by model id (or `provider/model`), a Map, or
 * a `(modelId, provider) => caps` function. Attaching the result to the
 * candidate is what lets `reorderByCapabilities` work on the chain alone,
 * without a second resolver threaded through the router.
 */
function resolveCapabilities(source, candidate, entry) {
  if (source === undefined || source === null) return undefined
  if (typeof source === 'function') {
    const value = source(candidate.modelId, candidate.provider)
    return value !== null && typeof value === 'object' ? value : undefined
  }
  const read = key => {
    const value = source instanceof Map ? source.get(key) : source[key]
    return value !== null && typeof value === 'object' ? value : undefined
  }
  if (source instanceof Map || typeof source === 'object') {
    for (const key of capabilityKeys(candidate, entry)) {
      const value = read(key)
      if (value !== undefined) return value
    }
  }
  return undefined
}

/**
 * Build the ordered candidate list for one request.
 *
 * The primary leads; fallbacks follow in their given order. The primary is
 * removed from the fallbacks (a combo routinely lists it twice, and trying the
 * same route twice in a row spends a round trip on a known-bad candidate), the
 * list is deduplicated by route, and `exclude` removes candidates outright —
 * that is how a caller drops a route it already knows is cooling down.
 *
 * Dedupe and exclusion are keyed by `provider/modelId` when the candidate names
 * a provider and by `modelId` otherwise, so the same model reached through two
 * different providers stays two candidates. An exclusion naming a provider
 * removes only that route; a bare string exclusion removes the model wherever
 * it appears.
 *
 * @param {object} [options]
 * @param {string|object} [options.primary] - model id or `{modelId, provider?, entry?}`
 * @param {Array<string|object>} [options.fallbacks] - same shapes, in order
 * @param {Array<string|object>} [options.exclude] - routes to drop
 * @param {Array<object>|Map<string,object>} [options.catalog] - entries with an `id`
 * @param {object|Map|Function} [options.capabilities] - capability table or resolver
 * @returns {Array<{modelId: string, provider?: string, entry?: object, capabilities?: object}>}
 */
export function buildChain({ primary, fallbacks, exclude, catalog, capabilities } = {}) {
  const index = catalogIndex(catalog)
  const excludedIds = new Set()
  const excludedRoutes = new Set()
  for (const item of listOf(exclude)) {
    if (typeof item === 'string') {
      const id = item.trim()
      if (id !== '') excludedIds.add(id)
      continue
    }
    if (item === null || typeof item !== 'object') continue
    const modelId = modelIdOf(item)
    if (modelId === '') continue
    const provider = nonEmptyString(item.provider)
    if (provider === undefined) excludedIds.add(modelId)
    else excludedRoutes.add(`${provider}/${modelId}`)
  }

  const seen = new Set()
  const chain = []
  for (const raw of [primary, ...listOf(fallbacks)]) {
    const candidate = toCandidate(raw)
    if (candidate === null) continue
    if (excludedIds.has(candidate.modelId)) continue
    if (excludedRoutes.has(candidate.modelId)) continue
    if (candidate.provider !== undefined && excludedRoutes.has(`${candidate.provider}/${candidate.modelId}`)) continue
    const key = candidate.provider === undefined ? candidate.modelId : `${candidate.provider}/${candidate.modelId}`
    if (seen.has(key)) continue
    seen.add(key)

    const entry = entryFor(index, candidate) ?? candidate.entry
    const resolved = resolveCapabilities(capabilities, candidate, entry)
    chain.push({
      modelId: candidate.modelId,
      ...candidate.provider === undefined ? {} : { provider: candidate.provider },
      ...entry === undefined ? {} : { entry },
      ...resolved === undefined ? {} : { capabilities: resolved },
    })
  }
  return chain
}

/** Does this value actually declare any hard capability? */
function hasCapabilityFlags(value) {
  return HARD_CAPABILITIES.some(capability => typeof value[capability] === 'boolean')
}

/**
 * The capability flags of one candidate: an explicit `capabilities` table entry
 * wins, then the resolved catalog `entry` (the free lane's entries carry
 * `vision` directly), then the candidate itself if it names any hard flag. A
 * table entry that declares nothing falls through, so an empty resolved object
 * cannot hide a catalog entry that does know the flags.
 */
function capabilitiesOf(candidate) {
  if (candidate === null || typeof candidate !== 'object') return {}
  const table = candidate.capabilities
  const entry = candidate.entry
  if (table !== null && typeof table === 'object' && hasCapabilityFlags(table)) return table
  if (entry !== null && typeof entry === 'object' && hasCapabilityFlags(entry)) return entry
  if (hasCapabilityFlags(candidate)) return candidate
  if (table !== null && typeof table === 'object') return table
  if (entry !== null && typeof entry === 'object') return entry
  return {}
}

/** Tier 0: all hard + all soft. Tier 1: all hard. Tier 2: the rest. */
function capabilityTier(candidate, hard, soft) {
  const caps = capabilitiesOf(candidate)
  if (!hard.every(capability => caps[capability] === true)) return 2
  return soft.every(capability => caps[capability] === true) ? 0 : 1
}

/**
 * Float the candidates that satisfy the request's capabilities to the front.
 *
 * Stable, and a no-op when nothing is required — the caller gets its own array
 * back untouched, which is what lets a caller chain this after `rotationOrder`
 * without worrying about the order it just computed. No candidate is ever
 * dropped: an incapable model stays in the chain as a later fallback, because
 * a degraded answer beats no answer once every capable route has failed.
 *
 * @param {Array<string|object>} candidates
 * @param {Set<string>|Array<string>|null} required - capability names
 * @returns {Array<string|object>} the same array when nothing is required
 */
export function reorderByCapabilities(candidates, required) {
  if (!Array.isArray(candidates) || candidates.length <= 1) return candidates
  const wanted = required instanceof Set ? required : new Set(listOf(required))
  if (wanted.size === 0) return candidates
  const hard = [...wanted].filter(capability => HARD_CAPABILITIES.includes(capability))
  const soft = [...wanted].filter(capability => !HARD_CAPABILITIES.includes(capability))
  return candidates
    .map((candidate, index) => ({ candidate, index, tier: capabilityTier(candidate, hard, soft) }))
    .sort((left, right) => left.tier - right.tier || left.index - right.index)
    .map(row => row.candidate)
}

/** The mime carried by a `data:` URI, or null. */
function dataUriMime(value) {
  if (typeof value !== 'string') return null
  const match = /^data:([^;,]+)/.exec(value)
  return match === null ? null : match[1]
}

/** Map one mime type onto the capability name a candidate is ranked by. */
function addByMime(required, mime) {
  if (typeof mime !== 'string' || mime === '') return
  const lower = mime.toLowerCase()
  if (lower.startsWith('image/')) required.add('vision')
  else if (lower === 'application/pdf') required.add('pdf')
  else if (lower.startsWith('audio/')) required.add('audioInput')
  else if (lower.startsWith('video/')) required.add('videoInput')
}

/**
 * One content block. The type list is 9router's, which covers the OpenAI chat,
 * OpenAI responses, Claude, Gemini and Vercel shapes; the mime fallbacks matter
 * because a `file`/`document` block carries its modality only in a nested mime
 * (or in a data URI), and a generic file with no mime is read as a PDF — that
 * is the only document modality the chain has a capability name for.
 */
function scanBlock(block, required) {
  if (block === null || typeof block !== 'object') return
  const type = block.type
  if (type === 'image_url' || type === 'image' || type === 'input_image') required.add('vision')
  if (type === 'input_audio' || type === 'audio_url' || type === 'audio') required.add('audioInput')
  if (type === 'input_video' || type === 'video_url' || type === 'video') required.add('videoInput')
  if (type === 'file' || type === 'document' || type === 'input_file') {
    let mime = null
    if (block.input_audio?.format) mime = `audio/${block.input_audio.format}`
    else if (block.file?.file_data) mime = dataUriMime(block.file.file_data)
    else if (block.source?.media_type) mime = block.source.media_type
    else if (block.source?.data) mime = dataUriMime(block.source.data)
    if (mime !== null) addByMime(required, mime)
    else required.add('pdf')
  }
  // Gemini parts carry the modality only in inlineData/fileData, and several
  // wire shapes put a bare mime on the block itself.
  addByMime(required, block.inlineData?.mimeType ?? block.fileData?.mimeType)
  addByMime(required, block.mime_type ?? block.mimeType)
  addByMime(required, block.source?.media_type)
}

/**
 * Media embedded in a string body: a caller that inlines a data URI in text is
 * still sending that modality. The source's else-if chain stopped at the first
 * URI it saw; a turn can carry more than one modality, so each marker is
 * checked independently here.
 */
function scanText(text, required) {
  if (text.includes('data:image/')) required.add('vision')
  if (text.includes('data:audio/')) required.add('audioInput')
  if (text.includes('data:video/')) required.add('videoInput')
  if (text.includes('data:application/pdf')) required.add('pdf')
}

/** One turn of any supported wire shape. */
function scanTurn(message, required) {
  if (message === null || typeof message !== 'object') return
  // Ollama / Hermes attach media as a sibling array.
  if (Array.isArray(message.images) && message.images.length > 0) required.add('vision')
  const attachments = message.experimental_attachments ?? message.attachments
  if (Array.isArray(attachments)) {
    for (const attachment of attachments) {
      if (attachment === null || typeof attachment !== 'object') continue
      const mime = attachment.contentType ?? attachment.mediaType ?? dataUriMime(attachment.url)
      if (typeof mime === 'string' && mime !== '') addByMime(required, mime)
      else if (attachment.url !== undefined || attachment.data !== undefined) required.add('vision')
    }
  }
  if (message.image_url !== undefined || message.image !== undefined) required.add('vision')
  if (message.audio_url !== undefined || message.audio !== undefined) required.add('audioInput')
  if (Array.isArray(message.content)) for (const block of message.content) scanBlock(block, required)
  else if (typeof message.content === 'string') scanText(message.content, required)
  // Gemini contents live in `parts`, which is scanned like a content list.
  if (Array.isArray(message.parts)) for (const block of message.parts) scanBlock(block, required)
}

/**
 * The trailing run of non-assistant turns — the current user turn. It may span
 * several messages (text plus an image, split across blocks), which is why the
 * whole run is returned rather than just the last message.
 */
function trailingUserItems(items) {
  if (!Array.isArray(items) || items.length === 0) return []
  const isAssistant = role => role === 'assistant' || role === 'model'
  let index = items.length - 1
  while (index >= 0 && !isAssistant(items[index]?.role)) index -= 1
  return items.slice(index + 1)
}

/** Pull the turn list out of a messages array or a whole request body. */
function turnItems(messages) {
  if (Array.isArray(messages)) return messages
  if (messages === null || typeof messages !== 'object') return []
  if (Array.isArray(messages.messages)) return messages.messages
  if (Array.isArray(messages.input)) return messages.input
  const contents = Array.isArray(messages.contents) ? messages.contents : messages.request?.contents
  return Array.isArray(contents) ? contents : []
}

/**
 * Which hard capabilities the current user turn needs.
 *
 * Only the trailing user turn is scanned: older turns' media has already been
 * consumed and the adapter placeholders it, so letting history decide would pin
 * every later turn of a long conversation to a vision model for no benefit.
 * Returns a Set of `vision` / `pdf` / `audioInput` / `videoInput`.
 *
 * @param {Array<object>|object} messages - a messages array, or a request body
 * @returns {Set<string>}
 */
export function detectRequiredCapabilities(messages) {
  const required = new Set()
  for (const message of trailingUserItems(turnItems(messages))) scanTurn(message, required)
  return required
}

/** 9router's normalization: a positive integer, or 1. */
function normalizeStickyLimit(stickyLimit) {
  const parsed = Number.parseInt(stickyLimit, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

/**
 * Order the candidates for this request.
 *
 * `fallback` (the default) returns the list unchanged and never touches the
 * rotation map: a fixed combo's order is the user's, and burning rotation
 * counters on it would make a later switch to round-robin start mid-cycle.
 * `round-robin` returns the list rotated so the current candidate leads, and
 * advances to the next candidate after `stickyLimit` requests — the sticky
 * count is what keeps a cheap model from being abandoned after a single turn
 * while still spreading load over a long session.
 *
 * The rotation map is keyed by combo id and must be injected for tests (or for
 * two independent routers in one process); the module-level map is the default.
 *
 * @param {Array<string|object>} candidates
 * @param {Map<string,{index:number,consecutiveUseCount:number}|number>} [state] - rotation map
 * @param {{strategy?: 'fallback'|'round-robin', stickyLimit?: number|string, comboId?: string}} [options]
 * @returns {Array<string|object>} the input array for `fallback`
 */
export function rotationOrder(candidates, state, { strategy = 'fallback', stickyLimit = 1, comboId } = {}) {
  if (!Array.isArray(candidates) || candidates.length <= 1) return candidates
  if (strategy !== 'round-robin') return candidates

  const rotation = state instanceof Map ? state : ROTATION_STATE
  const key = nonEmptyString(comboId) ?? DEFAULT_COMBO
  const existing = rotation.get(key)
  // A plain number is the shape an older caller stored; accept it so a hot
  // reload cannot reset a session's position.
  const current = typeof existing === 'number'
    ? { index: existing, consecutiveUseCount: 0 }
    : (existing ?? { index: 0, consecutiveUseCount: 0 })

  const length = candidates.length
  const rawIndex = Number.isInteger(current.index) ? current.index : 0
  const index = ((rawIndex % length) + length) % length
  const rotated = [...candidates.slice(index), ...candidates.slice(0, index)]

  const useCount = (Number.isFinite(current.consecutiveUseCount) ? current.consecutiveUseCount : 0) + 1
  if (useCount >= normalizeStickyLimit(stickyLimit)) {
    rotation.set(key, { index: (index + 1) % length, consecutiveUseCount: 0 })
  } else {
    rotation.set(key, { index, consecutiveUseCount: useCount })
  }
  return rotated
}

/**
 * Finish tokens that mean "the model stopped on purpose". `undefined` counts:
 * both wire readers treat a finish chunk with no token as a normal ending.
 */
const NORMAL_FINISH = Object.freeze(['stop', 'end_turn', 'stop_sequence'])

/**
 * May the turn move to the next candidate, and how?
 *
 * Ported from FCC's `assess_recovery`, whose rules exist to protect the client
 * from seeing the same answer twice:
 *
 * - STOP — a normal stop token (the turn is finished; restarting would duplicate
 *   it), structured output or an unsafe prefix (continuing would produce invalid
 *   JSON or a half-written tool call), a released tool call that may not be
 *   handed off, or a delivered turn with no portable prefix to continue from.
 * - RESTART — nothing was released, so the next candidate may start over.
 * - CONTINUE — text/thinking was released and is portable, so the next provider
 *   must continue that exact prefix (seed it with `continuationSeed`).
 * - HANDOFF — completed tool calls were already released to the client, which
 *   now owns them; only a provider that can pick the turn up from there may run.
 *
 * `retryable` defaults to true and `canHandoff` to true; pass them explicitly
 * from the failure verdict when the failure is not retryable, or when the wire
 * cannot hand off.
 *
 * @param {object} outcome
 * @param {boolean} [outcome.delivered] - anything reached the client
 * @param {boolean} [outcome.sawText] - answer text was released
 * @param {boolean} [outcome.sawToolCall] - a completed tool call was released
 * @param {boolean} [outcome.sawFinish] - a finish token arrived
 * @param {string} [outcome.finish] - the finish token itself
 * @param {boolean} [outcome.failedEnding] - the token names a failure, not a stop
 * @param {string} [outcome.partialText] - the released answer prefix
 * @param {string} [outcome.partialThinking] - the released reasoning prefix
 * @param {boolean} [outcome.structuredOutput] - the turn promised structured output
 * @param {string} [outcome.unsafeReason] - why the prefix must not be continued
 * @param {boolean} [outcome.retryable] - the failure permits another provider
 * @param {boolean} [outcome.canHandoff] - the wire supports a handoff
 * @returns {'RESTART'|'CONTINUE'|'HANDOFF'|'STOP'}
 */
export function assessRecovery(outcome = {}) {
  const delivered = outcome.delivered === true
  const sawToolCall = outcome.sawToolCall === true
  const sawFinish = outcome.sawFinish === true
  const failedEnding = outcome.failedEnding === true
  const finish = nonEmptyString(outcome.finish)
  const structuredOutput = outcome.structuredOutput === true
  const unsafeReason = nonEmptyString(outcome.unsafeReason)
  const retryable = outcome.retryable !== false
  const canHandoff = outcome.canHandoff !== false
  const partialText = typeof outcome.partialText === 'string' ? outcome.partialText : ''
  const partialThinking = typeof outcome.partialThinking === 'string' ? outcome.partialThinking : ''

  // A normal stop is checked before anything else, exactly as FCC does: a turn
  // that ended on purpose is finished, whatever else the outcome recorded.
  if (sawFinish && !failedEnding && (finish === undefined || NORMAL_FINISH.includes(finish))) return 'STOP'
  if (!delivered) return unsafeReason === undefined ? 'RESTART' : 'STOP'
  if (sawToolCall) {
    if (retryable && !structuredOutput && canHandoff) return 'HANDOFF'
    return 'STOP'
  }
  if (structuredOutput || unsafeReason !== undefined) return 'STOP'
  // Without the actual bytes there is nothing to seed the next provider with,
  // and a continuation from nothing is a restart wearing the wrong label.
  if (partialText === '' && partialThinking === '') return 'STOP'
  return 'CONTINUE'
}

/**
 * The prefix to seed the next provider with when `assessRecovery` says
 * CONTINUE. Non-strings become empty strings so the seed is always safe to
 * serialize into a request body.
 *
 * @param {string} partialText
 * @param {string} partialThinking
 * @returns {{text: string, thinking: string}}
 */
export function continuationSeed(partialText, partialThinking) {
  return {
    text: typeof partialText === 'string' ? partialText : '',
    thinking: typeof partialThinking === 'string' ? partialThinking : '',
  }
}
