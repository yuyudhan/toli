# Publishing toli (internal checklist)

Publishing means pushing toli to a new public repository. It happens only on the owner's explicit word. Until then
nothing here is pushed anywhere.

## Why a fresh repository

This working repository is not made public, and its history is not rewritten. Its early history contains personal
machine scripts and the author's commit identity; a rewrite is error-prone and the history has no value to outside
users. The public repository starts from one clean commit of the current tree instead. This repository stays the
owner's private working copy.

## Steps

1. **Clean tree.** On `main`, with every change committed:

        bun run check
        git status --short                     # must be empty
        git grep -nI -iE '<personal names, employer, internal hosts, home paths>' -- . ':!data'

    The grep must print nothing, or only intentional hits (the LICENSE copyright line). Keep the pattern list in
    private notes, not here.

2. **Secrets scan of the exact tree to publish.**

        rm -rf /tmp/toli-public && mkdir /tmp/toli-public
        git archive HEAD | tar -x -C /tmp/toli-public
        gitleaks detect --no-git --source /tmp/toli-public --redact

    Expect `no leaks found`. Any finding is fixed in this repository and committed, then the export is redone.

3. **New repository, no history.** Choose the public author name and email first (they go into every public
   commit).

        cd /tmp/toli-public
        git init --initial-branch=main
        git add -A
        git -c user.name="<public name>" -c user.email="<public email>" commit -m "Initial public release of toli"
        gitleaks detect --source . --log-opts=--all --redact      # history scan of the one commit

4. **Review before push.** Read the file list (`git ls-files`) once: no `data/`, `state/`, `config/`, `logs/`,
   `projects/`, `local/`, `.env*`. `just check` must pass (its guards check every Markdown link), and every
   `<toli-repo-url>` and `<toli-raw-url>` placeholder (`git grep -n '<toli-r'`) is replaced with the public URL.

5. **Push, only on the owner's word.** Create the empty public repository on the chosen forge, then:

        git remote add origin <public url>
        git push -u origin main

## After publishing

- Later public releases repeat steps 1-5 with a new export, or keep a separate public clone and copy changes into
  it; private history never reaches the public repository.
- Machine-specific helpers stay in each machine's gitignored `local/` (docs/helpers.md); nothing personal is
  added to tracked files.
