import type { Register, Timer } from 'claude-code'

// Companion of the "Claude Background Tasks" VSCodium extension.
// The extension writes stop requests to
//   ~/.claude/background-tasks/<sessionId>/stop.json   { requests: [{ id, taskId, at }] }
// and this plugin, running inside that session, stops each task with Claude's
// own TaskStop tool and reports back in
//   ~/.claude/background-tasks/<sessionId>/done.json   { results: { [id]: { ok, text, at } } }

type StopRequest = { id: string; taskId: string; at: number }
type StopResult = { ok: boolean; text: string; at: number }

let timer: Timer | undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
    if (!home) return result

    const handled = new Set<string>()
    let lastMtime = -1
    let busy = false

    const poll = async () => {
      if (busy) return
      busy = true
      try {
        const sid = await $.session.id()
        const dir = `${home}/.claude/background-tasks/${sid}`
        const reqFile = `${dir}/stop.json`
        if (!(await $.fs.exists(reqFile))) return
        const st = await $.fs.stat(reqFile)
        if (st.mtimeMs === lastMtime) return
        lastMtime = st.mtimeMs

        const doneFile = `${dir}/done.json`
        let done: { results: Record<string, StopResult> } = { results: {} }
        if (await $.fs.exists(doneFile)) {
          try { done = JSON.parse(await $.fs.read(doneFile)) } catch { /* rewrite it */ }
          for (const id of Object.keys(done.results ?? {})) handled.add(id)
        }
        done.results ??= {}

        let reqs: StopRequest[] = []
        try { reqs = JSON.parse(await $.fs.read(reqFile)).requests ?? [] } catch { return }
        const now = await $.clock.now()
        const fresh = reqs.filter(r => !handled.has(r.id) && now - r.at < 5 * 60_000)
        if (!fresh.length) return

        for (const r of fresh) {
          handled.add(r.id)
          let res: StopResult
          try {
            const ran = await $.tool.call({ tool: 'TaskStop', task_id: r.taskId })
            if (ran.deny !== undefined) res = { ok: false, text: ran.deny, at: now }
            else res = { ok: ran.isError !== true, text: ran.text ?? '', at: now }
          } catch (err) {
            res = { ok: false, text: String(err), at: now }
          }
          done.results[r.id] = res
          $.ui.toast(res.ok ? `Stopped background task ${r.taskId}` : `Could not stop ${r.taskId}: ${res.text.slice(0, 200)}`)
        }
        // keep the file small
        for (const [id, v] of Object.entries(done.results)) if (now - v.at > 60 * 60_000) delete done.results[id]
        await $.fs.write(doneFile, JSON.stringify(done, null, 1))
      } catch {
        /* never break the session over a stop request */
      } finally {
        busy = false
      }
    }

    timer?.cancel()
    timer = $.clock.every(1000, () => { void poll() })
    return result
  })
}
