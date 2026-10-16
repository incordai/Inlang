# Security policy

az compiles a `.az` file into a website and, optionally, a backend (accounts,
data tables, chat). Security problems in the compiler, in the sites and servers
it generates, or in the CLI tools are taken seriously.

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a security
problem.**

Report it privately on GitHub:
<https://github.com/incordai/inlang/security/advisories/new>
("Report a vulnerability" on the repository's **Security** tab). Only the
maintainers can see the report.

Please include:

- what is affected: the compiler, a generated site, the generated backend, the
  chat block, a CLI command (`az build`, `az dev`, `az mcp`, …);
- the `.az` file, configuration or request that shows the problem — the
  smallest one you can make;
- what an attacker can do with it;
- the commit (`git rev-parse HEAD`) you tested.

Never include real secrets, keys or other people's personal data in a report.

## What happens next

The maintainers confirm they have received the report, investigate it
privately, and agree a disclosure date with you. The fix is developed in a
private advisory, released, and then the advisory is published with credit to
you unless you ask to stay anonymous.

## Supported versions

az has not made a release yet. Security fixes go to the `main` branch; use the
latest `main`.

## Scope

In scope: anything that lets an attacker run code, read data they should not,
bypass sign-in or a data table's `allow` rules, ship a secret in a built site,
weaken a generated site's Content-Security-Policy, or make the chat block
render content outside its allowed components.

Out of scope: a vulnerability in a site author's own custom code (`raw`
components, ejected words), and findings that need an attacker who can already
edit the project's files or the server's `.env`.

## How the project checks itself

The checks that run on every change — secret scanning of every build, the
generated sites' security policy, the scanners in CI — are described in
[docs/security-scanning.md](docs/security-scanning.md) and
[docs/USAGE.md](docs/USAGE.md) §5.
