/**
 * Snapshot of a repository's HEAD, as reported by the VS Code Git API
 */
export interface HeadSnapshot {
    /** Branch name, undefined when HEAD is detached */
    name?: string;
    /** Commit hash HEAD points to */
    commit?: string;
}

/**
 * Decide whether a HEAD change represents a new commit on the current branch.
 *
 * Returns false for the first HEAD seen for a repository and for branch
 * switches, so that only commits (or pulls/amends/resets that move the
 * current branch) trigger tests.
 */
export function isNewCommit(previous: HeadSnapshot | undefined, current: HeadSnapshot): boolean {
    if (!current.commit || !previous?.commit) {
        return false;
    }
    return current.commit !== previous.commit && current.name === previous.name;
}
