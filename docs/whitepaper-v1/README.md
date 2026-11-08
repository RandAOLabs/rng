# RandAO whitepaper v1

This is the complete original RandAO whitepaper, copied from the archived RandAOLabs/RandAO-Whitepaper repo: LaTeX sources (`randao.tex`, `sections/`), images, bibliography, Makefile, setup notes (`docs/`) and the compiled `randao.pdf` that was published. It describes the first AO design (VRF provider network, RNG token section in `sections/rng_token.tex`). [`../paper/`](../paper/) is the later edition built from this same template: it rewrites the protocol around any-honest time-lock commit-reveal on HyperBEAM and adds the tiers section. The current v3 paper is [`../whitepaper/`](../whitepaper/).

## Original README


RandAO is a first-of-its-kind fully decentralized VRF protocol that leverages AO's hyper parallel computing to deliver fast, secure, and verifiable randomness. Through its decentralized provider network and utility token, RandAO ensures unmatched security and incentivization for random value generation.

**Learn more:** [ar://randao](ar://randao) | [randao.permagate.io](https://randao.permagate.io)

## Building the Whitepaper

To build this whitepaper, you'll need LaTeX installed. We provide two simple make commands:

First time setup - installs LaTeX and dependencies
```bash
make setup
```
> Note: Initial setup may take 10+ minutes due to LaTeX installation size. This is normal.

Build the whitepaper PDF
```bash
make compile
```

The compiled PDF will be generated as `randao.pdf` in the root directory.