import * as assert from 'assert';
import { isNewCommit } from '../../core/commitDetection';

suite('Commit detection', () => {
    test('detects a new commit on the same branch', () => {
        assert.strictEqual(isNewCommit(
            { name: 'main', commit: 'aaa111' },
            { name: 'main', commit: 'bbb222' }
        ), true);
    });

    test('ignores an unchanged HEAD', () => {
        assert.strictEqual(isNewCommit(
            { name: 'main', commit: 'aaa111' },
            { name: 'main', commit: 'aaa111' }
        ), false);
    });

    test('ignores branch switches', () => {
        assert.strictEqual(isNewCommit(
            { name: 'main', commit: 'aaa111' },
            { name: 'feature', commit: 'bbb222' }
        ), false);
    });

    test('ignores the first HEAD seen for a repository', () => {
        assert.strictEqual(isNewCommit(undefined, { name: 'main', commit: 'aaa111' }), false);
        assert.strictEqual(isNewCommit({ name: 'main' }, { name: 'main', commit: 'aaa111' }), false);
    });

    test('ignores a HEAD without a commit', () => {
        assert.strictEqual(isNewCommit({ name: 'main', commit: 'aaa111' }, { name: 'main' }), false);
    });

    test('treats checking out a commit (detached HEAD) as a branch switch', () => {
        assert.strictEqual(isNewCommit(
            { name: 'main', commit: 'aaa111' },
            { commit: 'bbb222' }
        ), false);
    });

    test('detects a new commit made on a detached HEAD', () => {
        assert.strictEqual(isNewCommit({ commit: 'aaa111' }, { commit: 'bbb222' }), true);
    });
});
