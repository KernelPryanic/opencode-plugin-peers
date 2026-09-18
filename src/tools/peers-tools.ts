/**
 * LLM-callable tools:
 *   - list_agents:  discover same-machine opencode peers
 *   - send_message: send a plain-text message to a peer
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import { z } from "zod"
import type { ListedPeer, RegistryInstance } from "../registry.js"
import type { Sender } from "../sender.js"
import type { RateLimiter } from "../queue.js"
import type { OutboxInstance } from "../outbox.js"
import { sameDirectory, sortPeers } from "../format.js"

export interface ToolsDeps {
  registry: RegistryInstance
  sender: ReturnType<typeof Sender>
  sendLimit: ReturnType<typeof RateLimiter>
  maxMessageBytes: number
  selfName: () => string
  selfInstanceId: string
  endpointForSession?: (sessionId: string) => { endpointId: string; name: string; directory: string } | null
  outbox?: Pick<OutboxInstance, "get" | "list">
}

function entryId(entry: ListedPeer["entry"]): string {
  return entry.version === 2 ? entry.endpointId : entry.instanceId
}

function isEndpointShaped(target: string): boolean {
  return /^(?:ses_|session-|workspace-)[A-Za-z0-9][A-Za-z0-9_-]*$/.test(target)
}

export function formatPeerList(
  peers: ListedPeer[],
  selfName: string,
  selfId: string,
  scopeDirectory?: string | null
): string {
  const online = sortPeers(peers.filter((p) => p.alive))
  const offline = sortPeers(peers.filter((p) => !p.alive))
  const scopeLabel = scopeDirectory ? ` (scope: directory ${scopeDirectory})` : " (scope: machine-wide)"
  const lines: string[] = []
  if (online.length === 0) {
    lines.push(`No peers online${scopeLabel}.`)
  } else {
    lines.push(`${online.length} peer(s) online${scopeLabel}:`)
    for (const p of online) {
      const e = p.entry
      const id = entryId(e)
      const role = e.version === 2 && e.parentSessionId ? "subagent" : "main"
      const session = e.activeSessionId
        ? `session ${e.activeSessionTitle ? `"${e.activeSessionTitle}" ` : ""}(${e.activeSessionId})`
        : "(no active session)"
      lines.push(
        `- "${e.name}" (id ${id}) — ${role} — ${e.directory} — ${session} — inbound: ${e.inboundPolicy}`
      )
    }
  }
  if (offline.length > 0) {
    lines.push(`${offline.length} peer(s) stale/offline (hidden from targeting):`)
    for (const p of offline) {
      lines.push(`- "${p.entry.name}" (id ${entryId(p.entry)}) — ${p.staleReason}`)
    }
  }
  lines.push(`You are "${selfName}" (id ${selfId}).`)
  return lines.join("\n")
}

export function buildPeerTools(deps: ToolsDeps): Record<string, ToolDefinition> {
  return {
    peer_message_status: tool({
      description: "Query the durable receipt and final ACK status of a peer message sent by this session.",
      args: {
        message_id: z.string().describe("Message ID returned by send_message"),
      },
      async execute(args, context) {
        const self = deps.endpointForSession?.(context.sessionID)
        if (!self) return `Error: sender session "${context.sessionID}" is not registered.`
        const record = deps.outbox?.get(self.endpointId, args.message_id)
        if (!record) return `Peer message "${args.message_id}" was not found in this session's outbox.`
        const receipt = record.receiptStatus ? `receipt: ${record.receiptStatus}` : "no transport receipt"
        const final = record.finalStatus ? `final: ${record.finalStatus}` : "awaiting final ACK"
        return `Message ${record.messageId} to "${record.toName}" — ${receipt}; ${final}${record.error ? `; error: ${record.error}` : ""}.`
      },
    }),

    list_agents: tool({
      description:
        "List other opencode session endpoints on this machine that you can exchange plain-text messages with. Machine-wide by default; set project_only or directory to narrow the listing. Shows each endpoint's name, endpoint id (ses_...), role (main/subagent), directory, session, and inbound policy.",
      args: {
        include_offline: z
          .boolean()
          .optional()
          .describe("Also list stale/offline registry entries (default false)"),
        project_only: z
          .boolean()
          .optional()
          .describe("Restrict the listing to peers in this session's own project directory"),
        directory: z
          .string()
          .optional()
          .describe("Restrict the listing to peers in this exact directory (slash-insensitive; case-insensitive only on Windows/macOS)"),
      },
      async execute(args, context) {
        let peers: ListedPeer[]
        try {
          peers = await deps.registry.list()
        } catch (err) {
          return `Failed to read peer registry: ${String(err)}`
        }
        const self = deps.endpointForSession?.(context.sessionID)
        const selfId = self?.endpointId ?? deps.selfInstanceId
        const requestedDirectory = args.directory?.trim() || null
        const scopeDirectory = requestedDirectory ?? (args.project_only ? self?.directory ?? null : null)
        if (args.project_only && !requestedDirectory && !self?.directory) {
          return "Error: this session is not registered yet; pass an explicit directory to scope the listing."
        }
        const shown = (args.include_offline ? peers : peers.filter((p) => p.alive))
          .filter((peer) => entryId(peer.entry) !== selfId)
          .filter((peer) => !scopeDirectory || sameDirectory(peer.entry.directory, scopeDirectory))
        return formatPeerList(shown, self?.name ?? deps.selfName(), selfId, scopeDirectory)
      },
    }),

    send_message: tool({
      description:
        "Send a plain-text message immediately to an exact opencode session on this machine, including while it is busy. Text only — no files or conversation history. Resolve the target with list_agents first if unsure.",
      args: {
        to: z.string().describe("Peer name, endpoint id (ses_...), or session id (see list_agents)"),
        message: z.string().describe("Plain-text message body"),
      },
      async execute(args, context) {
        const text = args.message
        if (!text.trim()) return "Error: message must not be empty."
        if (Buffer.byteLength(text, "utf8") > deps.maxMessageBytes) {
          return `Error: message exceeds ${deps.maxMessageBytes} bytes.`
        }

        const self = deps.endpointForSession?.(context.sessionID)
        if (deps.endpointForSession && !self) {
          return `Error: sender session "${context.sessionID}" is not registered.`
        }
        const selfId = self?.endpointId ?? deps.selfInstanceId
        const listed = await deps.registry.list()
        const target = args.to.trim()
        const knownExact = listed.find((peer) => entryId(peer.entry) === target)
          ?? listed.find((peer) => peer.entry.version === 2 && peer.entry.sessionId === target)
        if (knownExact) {
          if (entryId(knownExact.entry) === selfId) {
            return `Error: cannot send a peer message to your own endpoint "${target}" in the same session.`
          }
          if (!knownExact.alive) {
            return `Error: endpoint "${target}" appears offline (${knownExact.staleReason}).`
          }
        } else if (isEndpointShaped(target)) {
          return `Error: unknown endpoint ID "${target}".`
        }

        const peers = listed.filter((p) => p.alive && entryId(p.entry) !== selfId)
        const matches = knownExact ? [knownExact] : peers.filter((p) => p.entry.name === target)
        if (matches.length === 0) {
          const stale = listed.find((p) => !p.alive && p.entry.name === target)
          if (stale) {
            return `Error: peer "${target}" appears offline (${stale.staleReason}).`
          }
          const names = peers.map((p) => `"${p.entry.name}"`).join(", ") || "(none)"
          return `Error: no peer named "${target}". Online peers: ${names}`
        }
        if (matches.length > 1) {
          const candidates = matches
            .map((p) => `"${p.entry.name}" (id ${entryId(p.entry)})`)
            .join(", ")
          return `Error: "${target}" is ambiguous. Candidates: ${candidates}. Use an endpoint id (ses_…).`
        }

        const peer = matches[0].entry
        if (!deps.sendLimit(entryId(peer))) {
          return `Error: outbound rate limit reached for "${peer.name}"; try again in a minute.`
        }

        const result = await deps.sender.send(peer, text, self ? {
          instanceId: self.endpointId,
          name: self.name,
          directory: self.directory,
        } : undefined)
        if (!result.ok) return `Error: ${result.error}`
        const tracking = result.messageId ? ` Tracking ID: ${result.messageId}.` : ""
        switch (result.status) {
          case "delivered":
            return `Message delivered to "${peer.name}".${tracking}`
          case "duplicate":
            return `Message was already received by "${peer.name}".`
          case "queued":
            return `Message queued for "${peer.name}" (their session is busy); awaiting final delivery ACK.${tracking}`
          case "held":
            return `"${peer.name}" reviews inbound messages manually; your message awaits their approval.${tracking}`
          case "refused":
            return `Error: "${peer.name}" refuses inbound messages.`
          case "full":
            return `Error: "${peer.name}" queue is full; try again later.`
          default:
            return `Error: unexpected status from "${peer.name}".`
        }
      },
    }),
  }
}
