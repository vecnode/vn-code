/**
 * dsh-rust-dev — the dependency graph, from `cargo metadata`.
 *
 * Three questions this row exists to answer, none of which a person asks of a
 * terminal happily:
 *
 *   1. **Which crate is compiled twice?** Two semver-incompatible versions of
 *      `syn` are legal, common, and invisible until you look - and they cost
 *      compile time and binary size while making a trait mismatch between the
 *      two copies impossible to read.
 *   2. **What pulls the heavy thing in?** `rust_deps` reports the most-depended-on
 *      crates, so "why is openssl in my tree" starts from a name.
 *   3. **Which feature enabled this?** Features unify across the whole graph, so
 *      a crate you never mentioned can arrive with `default` features on. The
 *      chain is `cargo tree -e features -i <crate>`, which is a separate call.
 *
 * `cargo metadata` (WITH dependencies) needs a resolve, and a resolve needs the
 * registry. It therefore runs `--offline`: when the lockfile and the on-disk
 * cache can answer, they do; when they cannot, the caller is told to fetch
 * explicitly rather than having a download started on their behalf.
 */

/**
 * Read the resolved graph out of `cargo metadata` output.
 *
 * @param metadata - the parsed JSON document (with `resolve`).
 * @returns a compact model: packages by id, edges, workspace set.
 */
export function graphOf(metadata) {
  const packages = new Map()
  for (const entry of metadata.packages ?? []) {
    packages.set(entry.id, {
      id: entry.id,
      name: String(entry.name ?? ''),
      version: String(entry.version ?? ''),
      source: entry.source === null || entry.source === undefined ? 'workspace' : String(entry.source),
      manifestPath: String(entry.manifest_path ?? ''),
    })
  }
  const nodes = Array.isArray(metadata.resolve?.nodes) ? metadata.resolve.nodes : []
  const edges = new Map()
  const reverse = new Map()
  for (const node of nodes) {
    const from = packages.get(node.id)
    if (from === undefined) continue
    const targets = []
    for (const dep of node.deps ?? []) {
      const to = packages.get(dep.pkg)
      if (to === undefined) continue
      targets.push(to.id)
      const list = reverse.get(to.id) ?? []
      list.push({ id: from.id, name: from.name })
      reverse.set(to.id, list)
    }
    edges.set(node.id, targets)
  }
  const members = new Set(metadata.workspace_members ?? [])
  return { packages, nodes, edges, reverse, members }
}

/**
 * Crates present at more than one version, with who depends on each copy.
 *
 * A duplicate is only worth reporting for a real dependency: two workspace
 * members of the same name cannot happen, and a path dependency beside a
 * registry one is a different (and rarer) story that the `source` field tells.
 */
export function duplicateVersions(graph) {
  const byName = new Map()
  for (const entry of graph.packages.values()) {
    if (entry.source === 'workspace') continue
    const list = byName.get(entry.name) ?? []
    list.push(entry)
    byName.set(entry.name, list)
  }
  const result = []
  for (const [name, entries] of byName) {
    const versions = [...new Set(entries.map((entry) => entry.version))]
    if (versions.length < 2) continue
    result.push({
      name,
      versions: versions.sort(compareVersions).map((version) => {
        const copies = entries.filter((entry) => entry.version === version)
        const users = new Set()
        for (const copy of copies) {
          for (const user of graph.reverse.get(copy.id) ?? []) users.add(user.name)
        }
        return { version, usedBy: [...users].sort() }
      }),
    })
  }
  return result.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** Sort two semver strings by their numeric parts, never lexically. */
export function compareVersions(a, b) {
  const parse = (value) => String(value).split(/[.\-+]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0)
  const [a1, a2, a3] = parse(a)
  const [b1, b2, b3] = parse(b)
  return a1 - b1 || a2 - b2 || a3 - b3
}

/**
 * The crates the most other crates depend on - where the weight is.
 *
 * Counted over REGISTRY crates only: a workspace member appears once in the
 * reverse index per dependent and would dominate for no useful reason.
 */
export function mostDependedOn(graph, limit = 10) {
  const counts = []
  for (const entry of graph.packages.values()) {
    if (entry.source === 'workspace') continue
    const users = graph.reverse.get(entry.id) ?? []
    if (users.length === 0) continue
    counts.push({ name: entry.name, version: entry.version, dependents: users.length, sample: users.slice(0, 3).map((user) => user.name) })
  }
  return counts.sort((a, b) => b.dependents - a.dependents || (a.name < b.name ? -1 : 1)).slice(0, limit)
}

/** The workspace members' direct dependencies, by name, with the requirement. */
export function declaredDependencies(metadata) {
  const members = new Set(metadata.workspace_members ?? [])
  const declared = new Map()
  for (const entry of metadata.packages ?? []) {
    if (!members.has(entry.id)) continue
    for (const dep of entry.dependencies ?? []) {
      const name = String(dep.name ?? '')
      if (name === '' || declared.has(name)) continue
      declared.set(name, { name, req: String(dep.req ?? ''), kind: String(dep.kind ?? 'normal'), optional: dep.optional === true })
    }
  }
  return declared
}

/** How many packages, edges and workspace members the resolve holds. */
export function graphSize(graph) {
  let edgeCount = 0
  for (const targets of graph.edges.values()) edgeCount += targets.length
  return { packages: graph.packages.size, edges: edgeCount, members: graph.members.size }
}

/**
 * Parse the bounded text of `cargo tree -e features -i <crate>`.
 *
 * The tree is indentation and `──` glyphs; what matters is the chain of crate
 * names and the `feature "x"` / `feature "x" implies y` lines under each. Rather
 * than a full parser, the lines are kept verbatim (they are already the answer)
 * and the count of distinct features is derived.
 *
 * @param text - the child's stdout.
 * @returns `{ lines, features, truncatedLines }`.
 */
export function featureChain(text, maxLines = 40) {
  const lines = String(text ?? '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line !== '')
  const features = new Set()
  for (const line of lines) {
    for (const match of line.matchAll(/feature "([^"]+)"/g)) features.add(match[1])
  }
  return { lines: lines.slice(0, maxLines), features: [...features].sort(), truncatedLines: Math.max(0, lines.length - maxLines) }
}
