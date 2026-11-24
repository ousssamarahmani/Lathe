/**
 * Must-catch fixtures for the protected-path gate (P2-02). Every `fail` fixture
 * must produce its `rule`; every `pass` fixture must produce no finding.
 * A bypass found in review gets a fixture here before the fix.
 */
export interface PatchFixture {
  readonly name: string;
  readonly expect: 'pass' | 'fail';
  readonly rule?: string;
  readonly diff: string;
}

const p = (s: string): string => s.replace(/^\n/, '');

export const FIXTURES: readonly PatchFixture[] = [
  {
    name: 'allow-modify',
    expect: 'pass',
    diff: p(String.raw`
diff --git a/apps/support-desk/src/kb/index.ts b/apps/support-desk/src/kb/index.ts
index 1111111..2222222 100644
--- a/apps/support-desk/src/kb/index.ts
+++ b/apps/support-desk/src/kb/index.ts
@@ -1,3 +1,3 @@
 export const a = 1;
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/evil.yml
 export const c = 3;
`),
  },
  {
    name: 'allow-new-file',
    expect: 'pass',
    diff: p(String.raw`
diff --git a/apps/support-desk/src/kb/article.ts b/apps/support-desk/src/kb/article.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/apps/support-desk/src/kb/article.ts
@@ -0,0 +1,2 @@
+export const title = 'KB';
+export const body = '';
`),
  },
  {
    name: 'allow-rename-in-app',
    expect: 'pass',
    diff: p(String.raw`
diff --git a/apps/support-desk/src/kb/old.ts b/apps/support-desk/src/kb/new.ts
similarity index 100%
rename from apps/support-desk/src/kb/old.ts
rename to apps/support-desk/src/kb/new.ts
`),
  },
  {
    name: 'allow-space-and-b-slash-in-name',
    expect: 'pass',
    diff: p(String.raw`
diff --git a/apps/support-desk/src/a b/x.ts b/apps/support-desk/src/a b/x.ts
index 1111111..2222222 100644
--- a/apps/support-desk/src/a b/x.ts
+++ b/apps/support-desk/src/a b/x.ts
@@ -1 +1 @@
-old
+new
`),
  },
  {
    name: 'allow-no-newline-markers',
    expect: 'pass',
    diff: p(String.raw`
diff --git a/apps/support-desk/README.md b/apps/support-desk/README.md
index 1111111..2222222 100644
--- a/apps/support-desk/README.md
+++ b/apps/support-desk/README.md
@@ -1 +1 @@
-old
\ No newline at end of file
+new
\ No newline at end of file
`),
  },
  { name: 'allow-empty', expect: 'pass', diff: '' },
  {
    name: 'reject-workflow',
    expect: 'fail',
    rule: 'protected-paths.protected',
    diff: p(String.raw`
diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
index 1111111..2222222 100644
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -1 +1 @@
-      - run: pnpm test
+      - run: echo skipped
`),
  },
  {
    name: 'reject-harness-source',
    expect: 'fail',
    rule: 'protected-paths.protected',
    diff: p(String.raw`
diff --git a/packages/verification-harness/src/runner.ts b/packages/verification-harness/src/runner.ts
index 1111111..2222222 100644
--- a/packages/verification-harness/src/runner.ts
+++ b/packages/verification-harness/src/runner.ts
@@ -1 +1 @@
-const overall = computed;
+const overall = 'passed';
`),
  },
  {
    name: 'reject-delete-harness-file',
    expect: 'fail',
    rule: 'protected-paths.protected',
    diff: p(String.raw`
diff --git a/packages/verification-harness/src/runner.ts b/packages/verification-harness/src/runner.ts
deleted file mode 100644
index 1111111..0000000
--- a/packages/verification-harness/src/runner.ts
+++ /dev/null
@@ -1 +0,0 @@
-export {};
`),
  },
  {
    name: 'reject-rename-into-harness',
    expect: 'fail',
    rule: 'protected-paths.protected',
    diff: p(String.raw`
diff --git a/apps/support-desk/src/x.ts b/packages/verification-harness/src/x.ts
similarity index 100%
rename from apps/support-desk/src/x.ts
rename to packages/verification-harness/src/x.ts
`),
  },
  {
    name: 'reject-rename-policy-out',
    expect: 'fail',
    rule: 'protected-paths.protected',
    diff: p(String.raw`
diff --git a/packages/verification-harness/policies/protected-paths.json b/apps/support-desk/policy.json
similarity index 100%
rename from packages/verification-harness/policies/protected-paths.json
rename to apps/support-desk/policy.json
`),
  },
  {
    name: 'reject-copy-into-github',
    expect: 'fail',
    rule: 'protected-paths.protected',
    diff: p(String.raw`
diff --git a/apps/support-desk/x.yml b/.github/workflows/x.yml
similarity index 100%
copy from apps/support-desk/x.yml
copy to .github/workflows/x.yml
`),
  },
  {
    name: 'reject-case-variant',
    expect: 'fail',
    rule: 'protected-paths.protected',
    diff: p(String.raw`
diff --git a/.GitHub/workflows/ci.yml b/.GitHub/workflows/ci.yml
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ b/.GitHub/workflows/ci.yml
@@ -0,0 +1 @@
+on: push
`),
  },
  {
    name: 'reject-trailing-dot',
    expect: 'fail',
    rule: 'protected-paths.protected',
    diff: p(String.raw`
diff --git a/.github./workflows/x.yml b/.github./workflows/x.yml
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ b/.github./workflows/x.yml
@@ -0,0 +1 @@
+on: push
`),
  },
  {
    name: 'reject-traversal',
    expect: 'fail',
    rule: 'protected-paths.traversal',
    diff: p(String.raw`
diff --git a/apps/support-desk/../../.github/workflows/x.yml b/apps/support-desk/../../.github/workflows/x.yml
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ b/apps/support-desk/../../.github/workflows/x.yml
@@ -0,0 +1 @@
+on: push
`),
  },
  {
    name: 'reject-absolute-path',
    expect: 'fail',
    rule: 'protected-paths.invalid-path',
    diff: p(String.raw`
diff --git a//etc/passwd b//etc/passwd
index 1111111..2222222 100644
--- a//etc/passwd
+++ b//etc/passwd
@@ -1 +1 @@
-root
+toor
`),
  },
  {
    name: 'reject-backslash-path',
    expect: 'fail',
    rule: 'protected-paths.invalid-path',
    diff: p(String.raw`
diff --git a/.github\workflows\x.yml b/.github\workflows\x.yml
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ b/.github\workflows\x.yml
@@ -0,0 +1 @@
+on: push
`),
  },
  {
    name: 'reject-quoted-octal-path',
    expect: 'fail',
    rule: 'protected-paths.protected',
    diff: p(String.raw`
diff --git "a/.git\150ub/workflows/x.yml" "b/.git\150ub/workflows/x.yml"
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ "b/.git\150ub/workflows/x.yml"
@@ -0,0 +1 @@
+on: push
`),
  },
  {
    name: 'reject-new-symlink',
    expect: 'fail',
    rule: 'protected-paths.symlink',
    diff: p(String.raw`
diff --git a/apps/support-desk/harness b/apps/support-desk/harness
new file mode 120000
index 0000000..4444444
--- /dev/null
+++ b/apps/support-desk/harness
@@ -0,0 +1 @@
+../../packages/verification-harness
\ No newline at end of file
`),
  },
  {
    name: 'reject-mode-change-to-symlink',
    expect: 'fail',
    rule: 'protected-paths.symlink',
    diff: p(String.raw`
diff --git a/apps/support-desk/src/kb/index.ts b/apps/support-desk/src/kb/index.ts
old mode 100644
new mode 120000
`),
  },
  {
    name: 'reject-submodule',
    expect: 'fail',
    rule: 'protected-paths.submodule',
    diff: p(String.raw`
diff --git a/apps/support-desk/vendor b/apps/support-desk/vendor
new file mode 160000
index 0000000..5555555
--- /dev/null
+++ b/apps/support-desk/vendor
@@ -0,0 +1 @@
+Subproject commit 5555555555555555555555555555555555555555
`),
  },
  {
    name: 'reject-mode-only-on-protected',
    expect: 'fail',
    rule: 'protected-paths.protected',
    diff: p(String.raw`
diff --git a/.github/CODEOWNERS b/.github/CODEOWNERS
old mode 100644
new mode 100755
`),
  },
  {
    name: 'reject-binary-into-harness',
    expect: 'fail',
    rule: 'protected-paths.protected',
    diff: p(String.raw`
diff --git a/packages/verification-harness/fixtures/x.bin b/packages/verification-harness/fixtures/x.bin
new file mode 100644
index 0000000000000000000000000000000000000000..7777777777777777777777777777777777777777
GIT binary patch
literal 4
LcmZQzWMT#Y01f~L

literal 0
HcmV?d00001

`),
  },
  {
    name: 'reject-lockfile',
    expect: 'fail',
    rule: 'protected-paths.protected',
    diff: p(String.raw`
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index 1111111..2222222 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -1 +1 @@
-lockfileVersion: '9.0'
+lockfileVersion: '9.1'
`),
  },
  {
    name: 'reject-contracts',
    expect: 'fail',
    rule: 'protected-paths.protected',
    diff: p(String.raw`
diff --git a/packages/shared-contracts/src/gates.ts b/packages/shared-contracts/src/gates.ts
index 1111111..2222222 100644
--- a/packages/shared-contracts/src/gates.ts
+++ b/packages/shared-contracts/src/gates.ts
@@ -1 +1 @@
-export const GATE_ORDER = GateId.options;
+export const GATE_ORDER = [];
`),
  },
  {
    name: 'reject-kiro-steering',
    expect: 'fail',
    rule: 'protected-paths.protected',
    diff: p(String.raw`
diff --git a/.kiro/steering/security.md b/.kiro/steering/security.md
index 1111111..2222222 100644
--- a/.kiro/steering/security.md
+++ b/.kiro/steering/security.md
@@ -1 +1 @@
-Deny by default.
+Allow by default.
`),
  },
  {
    name: 'reject-hidden-target-header',
    expect: 'fail',
    rule: 'protected-paths.protected',
    diff: p(String.raw`
diff --git a/README.md b/README.md
index 1111111..2222222 100644
--- a/README.md
+++ b/.github/workflows/x.yml
@@ -1 +1 @@
-a
+b
`),
  },
  {
    name: 'reject-not-git-format',
    expect: 'fail',
    rule: 'protected-paths.unparseable',
    diff: p(String.raw`
--- a/apps/support-desk/x.ts
+++ b/apps/support-desk/x.ts
@@ -1 +1 @@
-a
+b
`),
  },
  {
    name: 'reject-unknown-header',
    expect: 'fail',
    rule: 'protected-paths.unparseable',
    diff: p(String.raw`
diff --git a/apps/support-desk/x.ts b/apps/support-desk/x.ts
x-lathe-skip-checks: true
--- a/apps/support-desk/x.ts
+++ b/apps/support-desk/x.ts
@@ -1 +1 @@
-a
+b
`),
  },
  {
    name: 'reject-truncated-hunk',
    expect: 'fail',
    rule: 'protected-paths.unparseable',
    diff: p(String.raw`
diff --git a/apps/support-desk/a.ts b/apps/support-desk/a.ts
index 1111111..2222222 100644
--- a/apps/support-desk/a.ts
+++ b/apps/support-desk/a.ts
@@ -1,1 +1,3 @@
-a
+b
diff --git a/.github/x b/.github/x
`),
  },
  {
    // B's review of #7: a plain diff after a binary section reached git apply unparsed.
    name: 'reject-plain-diff-after-binary',
    expect: 'fail',
    rule: 'protected-paths.unparseable',
    diff: p(String.raw`
diff --git a/apps/support-desk/logo.bin b/apps/support-desk/logo.bin
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
GIT binary patch
literal 4
LcmZQzWMT#Y01f~L

--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -1 +1 @@
-name: CI
+name: PWNED
`),
  },
  {
    name: 'reject-plain-diff-after-binary-reverse-block',
    expect: 'fail',
    rule: 'protected-paths.unparseable',
    diff: p(String.raw`
diff --git a/apps/support-desk/logo.bin b/apps/support-desk/logo.bin
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
GIT binary patch
literal 4
LcmZQzWMT#Y01f~L

literal 4
LcmZQzWMT#Y01f~L

--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -1 +1 @@
-name: CI
+name: PWNED
`),
  },
  {
    name: 'reject-garbage-in-binary-data',
    expect: 'fail',
    rule: 'protected-paths.unparseable',
    diff: p(String.raw`
diff --git a/apps/support-desk/logo.bin b/apps/support-desk/logo.bin
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
GIT binary patch
literal 4
LcmZQzWMT#Y01f~L
+++ b/.github/workflows/ci.yml

`),
  },
  {
    name: 'allow-binary-in-app-with-reverse-block',
    expect: 'pass',
    diff: p(String.raw`
diff --git a/apps/support-desk/logo.bin b/apps/support-desk/logo.bin
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
GIT binary patch
literal 4
LcmZQzWMT#Y01f~L

literal 4
LcmZQzWMT#Y01f~L

diff --git a/apps/support-desk/src/kb/index.ts b/apps/support-desk/src/kb/index.ts
index 1111111..2222222 100644
--- a/apps/support-desk/src/kb/index.ts
+++ b/apps/support-desk/src/kb/index.ts
@@ -1 +1 @@
-export const a = 1;
+export const a = 2;
`),
  },
];
