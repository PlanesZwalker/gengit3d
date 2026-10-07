import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseGitLog } from '../src/gitlog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dirname, 'fixtures');

function loadFixture(name) {
    return readFileSync(join(fixtures, name), 'utf8');
}

describe('parseGitLog', () => {
    it('parses a simple 3-commit history', () => {
        const raw = loadFixture('simple.gitlog');
        const graph = parseGitLog(raw, '/fake/repo');

        expect(graph.nodes).toHaveLength(3);
        expect(graph.edges).toHaveLength(2);
        expect(graph.head).toBe('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0');

        // Check first commit (root)
        const root = graph.nodes[0];
        expect(root.id).toBe('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0');
        expect(root.author).toBe('Alice Smith');
        expect(root.email).toBe('alice@example.com');
        expect(root.subject).toBe('Initial commit');
        expect(root.parents).toEqual([]);
        expect(root.depth).toBe(0);

        // Check second commit
        const second = graph.nodes[1];
        expect(second.parents).toEqual(['a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0']);
        expect(second.depth).toBe(1);

        // Check third commit
        const third = graph.nodes[2];
        expect(third.parents).toEqual(['b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0a1']);
        expect(third.depth).toBe(2);
    });

    it('assigns branch names from refs', () => {
        const raw = loadFixture('simple.gitlog');
        const graph = parseGitLog(raw, '/fake/repo');

        // First commit has "HEAD -> main, origin/main"
        expect(graph.nodes[0].branchName).toBe('main');
    });

    it('handles merge commits (multiple parents)', () => {
        const raw = loadFixture('merge.gitlog');
        const graph = parseGitLog(raw, '/fake/repo');

        const merge = graph.nodes.find(n => n.subject === 'Merge branch dev');
        expect(merge).toBeDefined();
        expect(merge.parents).toHaveLength(2);
        expect(merge.depth).toBe(2);
    });

    it('handles multiline commit messages', () => {
        const raw = loadFixture('multiline.gitlog');
        const graph = parseGitLog(raw, '/fake/repo');

        const commit = graph.nodes.find(n => n.subject.includes('multiline'));
        expect(commit).toBeDefined();
        // The subject should be the first line
        expect(commit.subject).toBe('Add multiline message support');
    });

    it('handles authors with special characters', () => {
        const raw = loadFixture('special-chars.gitlog');
        const graph = parseGitLog(raw, '/fake/repo');

        const commit = graph.nodes.find(n => n.author === 'José García');
        expect(commit).toBeDefined();
        expect(commit.email).toBe('jose@example.com');
    });

    it('handles empty input', () => {
        const graph = parseGitLog('', '/fake/repo');
        expect(graph.nodes).toHaveLength(0);
        expect(graph.edges).toHaveLength(0);
        expect(graph.head).toBeNull();
    });

    it('computes depth correctly for branching history', () => {
        const raw = loadFixture('branching.gitlog');
        const graph = parseGitLog(raw, '/fake/repo');

        // Find the merge commit
        const merge = graph.nodes.find(n => n.subject === 'Merge feature branch');
        expect(merge).toBeDefined();
        // Depth should be the longest path
        expect(merge.depth).toBeGreaterThanOrEqual(2);
    });
});
