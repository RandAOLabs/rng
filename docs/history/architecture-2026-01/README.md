# Architecture diagrams, January 2026 (abandoned)

These are the PlantUML diagrams for the January 2026 multi-chain design: Ethereum and Solana random contracts, a provider network with commit and reveal components, and a whisper-network client. That design was abandoned; RNG runs on AO/HyperBEAM instead. The current design is in [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md).

Copied in full from the archived RandAOLabs/architecture-diagrams repo: `diagram-definitions/` (sources), `diagram-images/` (rendered PNGs), `convert-diagrams.sh` with the small Docker renderer (`Dockerfile`, `docker-compose.yml`) and its CI workflow under `.github/` (inert here).

## Original README


This repository contains UML diagrams describing the data structures, interfaces, and components used by the RNG (Random Number Generation) protocol.

**This is part of the RNG PROTOCOL MONO REPO:**  
🔗 [https://github.com/RandAOLabs/RNG-PROTOCOL-MONO](https://github.com/RandAOLabs/RNG-PROTOCOL-MONO)

## Overview

The UML diagrams document the protocol's architecture including:

- **Data Structures** - Core entities and their relationships
- **Interfaces** - Contract interfaces for different blockchain implementations  
- **Components** - System components and their interactions
- 
## Development

### Prerequisites
- Docker
- Docker Compose

### Generating PNG Diagrams

To convert all PlantUML diagrams to PNG format:

```bash
docker-compose up --build
```

This will:
1. Process all `.puml` files in [`diagram-definitions/`](diagram-definitions)
2. Generate corresponding PNG files in [`diagram-images/`](diagram-images)  
3. Preserve the exact directory structure
4. Apply styling from [`style.puml`](diagram-definitions/style.puml)
5. Provide detailed logging of conversion progress

### Style Guide

All diagrams use the style defined in [`diagram-definitions/style.puml`](diagram-definitions/style.puml):