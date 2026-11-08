package main

import (
	"context"
	"fmt"
	"log"
	"time"

	// 🔁 CHANGE "whisper-mvp-go" TO MATCH YOUR MODULE NAME FROM go.mod IF DIFFERENT
	"whisper-mvp-go/internal/chain"
	"whisper-mvp-go/internal/config"
)

func main() {
	// 1) Load config from env
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config error: %v", err)
	}

	// 2) Build chain registry client
	regClient, err := chain.NewETHRegistryClient(cfg.Chain)
	if err != nil {
		log.Fatalf("chain client error: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// 3) Register this node
	fmt.Printf("Registering peer:\n  nodeName=%s\n  multiaddr=%s\n",
		cfg.P2P.NodeName, cfg.P2P.ExternalMultiaddr)

	if err := regClient.RegisterPeer(ctx, cfg.P2P.NodeName, cfg.P2P.ExternalMultiaddr); err != nil {
		log.Fatalf("RegisterPeer error: %v", err)
	}

	// 4) Mark it active as well (second tx)
	if err := regClient.SetActive(ctx, true); err != nil {
		log.Fatalf("SetActive error: %v", err)
	}

	fmt.Println("Waiting a few seconds for txs to be mined...")
	time.Sleep(15 * time.Second)

	// 5) Dump ALL peers (active + inactive)
	allPeers, err := regClient.GetAllPeers(ctx)
	if err != nil {
		log.Fatalf("GetAllPeers error: %v", err)
	}

	fmt.Println("All peers in PeerRegistry:")
	for _, p := range allPeers {
		fmt.Printf("- %s | addr=%s | active=%v | lastSeen=%d | multiaddr=%s\n",
			p.NodeName, p.Address.Hex(), p.Active, p.LastSeen, p.Multiaddr)
	}

	// 6) Dump only ACTIVE peers
	activePeers, err := regClient.GetActivePeers(ctx)
	if err != nil {
		log.Fatalf("GetActivePeers error: %v", err)
	}

	fmt.Println("\nActive peers in PeerRegistry:")
	if len(activePeers) == 0 {
		fmt.Println("- (none)")
	} else {
		for _, p := range activePeers {
			fmt.Printf("- %s | addr=%s | active=%v | lastSeen=%d | multiaddr=%s\n",
				p.NodeName, p.Address.Hex(), p.Active, p.LastSeen, p.Multiaddr)
		}
	}
}
