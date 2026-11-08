package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

type ChainConfig struct {
	RPCURL          string
	ChainID         int64  // e.g. 11155111 for Sepolia
	PrivateKeyHex   string // 0x-prefixed or not
	RegistryAddress string // 0x... contract address
}

type P2PConfig struct {
	NodeName          string
	ExternalMultiaddr string // full libp2p multiaddr for this node (for now from env)
}

type NodeConfig struct {
	Chain ChainConfig
	P2P   P2PConfig
}

func getenv(key, def string) string {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	return v
}

func normalizeMultiaddr(raw string) string {
	// Fix Git Bash path mangling on Windows, e.g. "C:/Program Files/Git/dns4/..."
	const gitPrefix = "C:/Program Files/Git"
	if strings.HasPrefix(raw, gitPrefix) {
		idx := strings.Index(raw, "/dns4/")
		if idx != -1 {
			return raw[idx:]
		}
	}
	return raw
}

func Load() (NodeConfig, error) {
	chainIDStr := getenv("CHAIN_ID", "11155111") // default: Sepolia
	chainID, err := strconv.ParseInt(chainIDStr, 10, 64)
	if err != nil {
		return NodeConfig{}, fmt.Errorf("invalid CHAIN_ID %q: %w", chainIDStr, err)
	}

	chainCfg := ChainConfig{
		RPCURL:          getenv("CHAIN_RPC_URL", ""),
		ChainID:         chainID,
		PrivateKeyHex:   getenv("CHAIN_PRIVATE_KEY_HEX", ""),
		RegistryAddress: getenv("PEER_REGISTRY_ADDRESS", ""),
	}

	if chainCfg.RPCURL == "" {
		return NodeConfig{}, fmt.Errorf("CHAIN_RPC_URL is required")
	}
	if chainCfg.PrivateKeyHex == "" {
		return NodeConfig{}, fmt.Errorf("CHAIN_PRIVATE_KEY_HEX is required")
	}
	if chainCfg.RegistryAddress == "" {
		return NodeConfig{}, fmt.Errorf("PEER_REGISTRY_ADDRESS is required")
	}

	p2pCfg := P2PConfig{
		NodeName:          getenv("NODE_NAME", "peer1"),
		ExternalMultiaddr: normalizeMultiaddr(getenv("P2P_EXTERNAL_MULTIADDR", "")),
	}

	if p2pCfg.ExternalMultiaddr == "" {
		return NodeConfig{}, fmt.Errorf("P2P_EXTERNAL_MULTIADDR is required")
	}

	return NodeConfig{
		Chain: chainCfg,
		P2P:   p2pCfg,
	}, nil
}
