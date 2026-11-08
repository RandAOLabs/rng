package chain

import (
	"context"
	"crypto/ecdsa"
	"fmt"
	"math/big"
	"strings"

	// go-ethereum
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"

	// 🔁 CHANGE "whisper-mvp-go" TO YOUR MODULE NAME FROM go.mod
	"whisper-mvp-go/internal/config"
	"whisper-mvp-go/pkg/peerregistry"
)

type PeerRecord struct {
	Address   common.Address
	NodeName  string
	Multiaddr string
	LastSeen  uint64
	Active    bool
}

type RegistryClient interface {
	RegisterPeer(ctx context.Context, nodeName, multiaddr string) error
	SetActive(ctx context.Context, active bool) error
	GetAllPeers(ctx context.Context) ([]PeerRecord, error)
	GetActivePeers(ctx context.Context) ([]PeerRecord, error)
}

type ETHRegistryClient struct {
	cfg      config.ChainConfig
	client   *ethclient.Client
	contract *peerregistry.Peerregistry
	privKey  *ecdsa.PrivateKey
	from     common.Address
	chainID  *big.Int
}

func NewETHRegistryClient(cfg config.ChainConfig) (*ETHRegistryClient, error) {
	if cfg.RPCURL == "" {
		return nil, fmt.Errorf("RPC URL is empty")
	}
	if cfg.PrivateKeyHex == "" {
		return nil, fmt.Errorf("private key is empty")
	}
	if cfg.RegistryAddress == "" {
		return nil, fmt.Errorf("registry address is empty")
	}

	ec, err := ethclient.Dial(cfg.RPCURL)
	if err != nil {
		return nil, fmt.Errorf("dial RPC: %w", err)
	}

	pkHex := strings.TrimPrefix(cfg.PrivateKeyHex, "0x")
	privKey, err := crypto.HexToECDSA(pkHex)
	if err != nil {
		return nil, fmt.Errorf("invalid private key: %w", err)
	}

	fromAddr := crypto.PubkeyToAddress(privKey.PublicKey)
	chainID := big.NewInt(cfg.ChainID)

	regAddr := common.HexToAddress(cfg.RegistryAddress)
	contract, err := peerregistry.NewPeerregistry(regAddr, ec)
	if err != nil {
		return nil, fmt.Errorf("bind PeerRegistry: %w", err)
	}

	return &ETHRegistryClient{
		cfg:      cfg,
		client:   ec,
		contract: contract,
		privKey:  privKey,
		from:     fromAddr,
		chainID:  chainID,
	}, nil
}

func (c *ETHRegistryClient) txOpts(ctx context.Context) (*bind.TransactOpts, error) {
	opts, err := bind.NewKeyedTransactorWithChainID(c.privKey, c.chainID)
	if err != nil {
		return nil, err
	}
	opts.From = c.from
	opts.Context = ctx
	return opts, nil
}

// ---------------------------------------------------------
//  Write methods
// ---------------------------------------------------------

func (c *ETHRegistryClient) RegisterPeer(ctx context.Context, nodeName, multiaddr string) error {
	opts, err := c.txOpts(ctx)
	if err != nil {
		return fmt.Errorf("tx opts: %w", err)
	}

	tx, err := c.contract.RegisterPeer(opts, nodeName, multiaddr)
	if err != nil {
		return fmt.Errorf("registerPeer tx: %w", err)
	}

	fmt.Printf("[chain] sent RegisterPeer tx: %s\n", tx.Hash().Hex())
	return nil
}

func (c *ETHRegistryClient) SetActive(ctx context.Context, active bool) error {
	opts, err := c.txOpts(ctx)
	if err != nil {
		return fmt.Errorf("tx opts: %w", err)
	}

	tx, err := c.contract.SetActive(opts, active)
	if err != nil {
		return fmt.Errorf("setActive tx: %w", err)
	}

	fmt.Printf("[chain] sent SetActive(%v) tx: %s\n", active, tx.Hash().Hex())
	return nil
}

// ---------------------------------------------------------
//  Read methods
// ---------------------------------------------------------

func (c *ETHRegistryClient) GetAllPeers(ctx context.Context) ([]PeerRecord, error) {
	callOpts := &bind.CallOpts{
		From:    c.from,
		Context: ctx,
	}

	res, err := c.contract.GetAllPeers(callOpts)
	if err != nil {
		return nil, fmt.Errorf("GetAllPeers call: %w", err)
	}

	addresses := res.Peers
	infos := res.Infos

	if len(addresses) != len(infos) {
		return nil, fmt.Errorf("GetAllPeers: mismatched lengths")
	}

	out := make([]PeerRecord, 0, len(addresses))
	for i, addr := range addresses {
		info := infos[i]
		out = append(out, PeerRecord{
			Address:   addr,
			NodeName:  info.NodeName,
			Multiaddr: info.Multiaddr,
			LastSeen:  info.LastSeen,
			Active:    info.Active,
		})
	}

	return out, nil
}

func (c *ETHRegistryClient) GetActivePeers(ctx context.Context) ([]PeerRecord, error) {
	callOpts := &bind.CallOpts{
		From:    c.from,
		Context: ctx,
	}

	// Solidity: getActivePeers() returns (address[] peers, PeerInfo[] infos)
	res, err := c.contract.GetActivePeers(callOpts)
	if err != nil {
		return nil, fmt.Errorf("GetActivePeers call: %w", err)
	}

	addresses := res.Peers
	infos := res.Infos

	if len(addresses) != len(infos) {
		return nil, fmt.Errorf("GetActivePeers: mismatched lengths")
	}

	out := make([]PeerRecord, 0, len(addresses))
	for i, addr := range addresses {
		info := infos[i]
		out = append(out, PeerRecord{
			Address:   addr,
			NodeName:  info.NodeName,
			Multiaddr: info.Multiaddr,
			LastSeen:  info.LastSeen,
			Active:    info.Active,
		})
	}

	return out, nil
}
