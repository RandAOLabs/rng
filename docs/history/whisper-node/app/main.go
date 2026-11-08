package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	libp2p "github.com/libp2p/go-libp2p"
	pubsub "github.com/libp2p/go-libp2p-pubsub"

	cryptoCore "github.com/libp2p/go-libp2p/core/crypto"
	hostcore "github.com/libp2p/go-libp2p/core/host"
	network "github.com/libp2p/go-libp2p/core/network"
	peer "github.com/libp2p/go-libp2p/core/peer"
	protocol "github.com/libp2p/go-libp2p/core/protocol"

	multiaddr "github.com/multiformats/go-multiaddr"

	// 🔁 CHANGE MODULE PATH IF YOUR go.mod MODULE NAME IS DIFFERENT
	chainpkg "whisper-mvp-go/internal/chain"
	nodecfg "whisper-mvp-go/internal/config"
)

const (
	defaultTopic      = "whisper/round/messages"
	catchupProtocol   = protocol.ID("/whisper/catchup/1.0.0")
	identityFileName  = "identity.key"
	defaultListenPort = 4001
	defaultRoundID    = 1
	defaultLogLevel   = "info"

	catchupRequestTimeout = 2 * time.Second
)

// -------------------- Logging --------------------

type LogLevel int

const (
	LogDebug LogLevel = iota
	LogInfo
	LogWarn
	LogError
)

type Logger struct {
	level  LogLevel
	prefix string
	mu     sync.Mutex
}

func NewLogger(levelStr, prefix string) *Logger {
	lvl := LogInfo
	switch strings.ToLower(strings.TrimSpace(levelStr)) {
	case "debug":
		lvl = LogDebug
	case "info":
		lvl = LogInfo
	case "warn", "warning":
		lvl = LogWarn
	case "error":
		lvl = LogError
	}
	return &Logger{level: lvl, prefix: prefix}
}

func (l *Logger) log(lvl LogLevel, format string, args ...any) {
	if lvl < l.level {
		return
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	tag := "INFO"
	switch lvl {
	case LogDebug:
		tag = "DEBUG"
	case LogInfo:
		tag = "INFO"
	case LogWarn:
		tag = "WARN"
	case LogError:
		tag = "ERROR"
	}

	msg := fmt.Sprintf(format, args...)
	fmt.Printf("[%s] [%s] %s\n", l.prefix, tag, msg)
}

func (l *Logger) Debug(f string, a ...any) { l.log(LogDebug, f, a...) }
func (l *Logger) Info(f string, a ...any)  { l.log(LogInfo, f, a...) }
func (l *Logger) Warn(f string, a ...any)  { l.log(LogWarn, f, a...) }
func (l *Logger) Error(f string, a ...any) { l.log(LogError, f, a...) }

// -------------------- P2P Config (local) --------------------

type Config struct {
	NodeName   string
	ProviderID string
	RoundID    int
	ListenPort int

	// Identity:
	// 1) Seeded deterministic identity (preferred)
	// 2) Fallback: persisted random key in DATA_DIR
	IdentitySeed string

	TopicName string
	LogLevel  string
	DataDir   string

	// Optional: used only for "expected" committee size for ROUND COMPLETE log.
	CommitteeOrder []string
}

func envStr(key, def string) string {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	return v
}

func envInt(key string, def int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

func parseCSV(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func loadConfig() Config {
	node := envStr("NODE_NAME", "peer1")
	provider := envStr("PROVIDER_ID", node)

	round := envInt("ROUND_ID", defaultRoundID)
	port := envInt("LISTEN_PORT", defaultListenPort)

	seed := envStr("IDENTITY_SEED", "")

	topic := envStr("TOPIC_NAME", defaultTopic)
	loglvl := envStr("LOG_LEVEL", defaultLogLevel)
	dataDir := envStr("DATA_DIR", "/data")

	committeeOrder := parseCSV(envStr("COMMITTEE_ORDER", "")) // optional, for expected committee size only

	return Config{
		NodeName:       node,
		ProviderID:     provider,
		RoundID:        round,
		ListenPort:     port,
		IdentitySeed:   seed,
		TopicName:      topic,
		LogLevel:       loglvl,
		DataDir:        dataDir,
		CommitteeOrder: committeeOrder,
	}
}

// -------------------- Messages --------------------

type RoundMsg struct {
	Round    int    `json:"round"`
	Provider string `json:"provider"`
	Node     string `json:"node"`
	TsUnix   int64  `json:"ts_unix"`
	Payload  string `json:"payload"`
}

type CatchupRequest struct {
	Round int `json:"round"`
}

type CatchupResponse struct {
	Round    int        `json:"round"`
	Messages []RoundMsg `json:"messages"`
}

// -------------------- Round Cache --------------------

type RoundCache struct {
	mu    sync.RWMutex
	round map[int]map[string]RoundMsg // round -> provider -> msg
}

func NewRoundCache() *RoundCache {
	return &RoundCache{
		round: make(map[int]map[string]RoundMsg),
	}
}

func (c *RoundCache) Upsert(msg RoundMsg) (added bool, count int) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if _, ok := c.round[msg.Round]; !ok {
		c.round[msg.Round] = make(map[string]RoundMsg)
	}
	_, existed := c.round[msg.Round][msg.Provider]
	c.round[msg.Round][msg.Provider] = msg
	return !existed, len(c.round[msg.Round])
}

func (c *RoundCache) GetRound(round int) []RoundMsg {
	c.mu.RLock()
	defer c.mu.RUnlock()

	mp := c.round[round]
	if mp == nil {
		return nil
	}

	out := make([]RoundMsg, 0, len(mp))
	for _, v := range mp {
		out = append(out, v)
	}

	sort.Slice(out, func(i, j int) bool {
		return out[i].Provider < out[j].Provider
	})

	return out
}

func (c *RoundCache) Count(round int) int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.round[round] == nil {
		return 0
	}
	return len(c.round[round])
}

func (c *RoundCache) Providers(round int) []string {
	c.mu.RLock()
	defer c.mu.RUnlock()

	mp := c.round[round]
	if mp == nil {
		return nil
	}

	out := make([]string, 0, len(mp))
	for p := range mp {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

// -------------------- Identity --------------------

// deterministicReader returns a stable byte stream derived from seed+name.
func deterministicReader(seed, name string) io.Reader {
	b1 := sha256.Sum256([]byte(seed + "::" + name + "::1"))
	b2 := sha256.Sum256([]byte(seed + "::" + name + "::2"))
	buf := append(b1[:], b2[:]...)
	return bytes.NewReader(buf)
}

func derivePrivKeyFromSeed(seed, name string) (cryptoCore.PrivKey, error) {
	if seed == "" {
		return nil, errors.New("empty seed")
	}
	r := deterministicReader(seed, name)
	priv, _, err := cryptoCore.GenerateEd25519Key(r)
	return priv, err
}

func identityPath(cfg Config) string {
	return filepath.Join(cfg.DataDir, identityFileName)
}

func loadOrCreatePrivKey(cfg Config, log *Logger) (cryptoCore.PrivKey, error) {
	// Preferred: deterministic seed mode.
	if cfg.IdentitySeed != "" {
		priv, err := derivePrivKeyFromSeed(cfg.IdentitySeed, cfg.NodeName)
		if err != nil {
			return nil, err
		}

		// Optional: write to disk for visibility.
		path := identityPath(cfg)
		if err := os.MkdirAll(cfg.DataDir, 0o755); err == nil {
			if b, err2 := cryptoCore.MarshalPrivateKey(priv); err2 == nil {
				_ = os.WriteFile(path, b, 0o600)
			}
		}

		log.Info("using deterministic identity (seeded)")
		return priv, nil
	}

	// Fallback: persisted key file.
	path := identityPath(cfg)
	if b, err := os.ReadFile(path); err == nil && len(b) > 0 {
		priv, err2 := cryptoCore.UnmarshalPrivateKey(b)
		if err2 == nil {
			log.Info("loaded identity key: %s", path)
			return priv, nil
		}
	}

	// Create new random key and persist.
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return nil, err
	}

	priv, _, err := cryptoCore.GenerateEd25519Key(rand.Reader)
	if err != nil {
		return nil, err
	}

	if b, err := cryptoCore.MarshalPrivateKey(priv); err == nil {
		_ = os.WriteFile(path, b, 0o600)
	}

	log.Info("generated new identity key: %s", path)
	return priv, nil
}

// -------------------- Chain-based discovery --------------------

// connectActiveFromRegistry uses on-chain registry to dial active peers.
func connectActiveFromRegistry(ctx context.Context, h hostcore.Host, log *Logger, regClient chainpkg.RegistryClient) {
	peers, err := regClient.GetActivePeers(ctx)
	if err != nil {
		log.Warn("GetActivePeers failed: %v", err)
		return
	}

	if len(peers) == 0 {
		log.Info("chain registry returned 0 active peers")
		return
	}

	log.Info("chain registry returned %d active peers", len(peers))

	for _, p := range peers {
		maddrStr := strings.TrimSpace(p.Multiaddr)
		if maddrStr == "" {
			continue
		}

		ma, err := multiaddr.NewMultiaddr(maddrStr)
		if err != nil {
			log.Info("invalid multiaddr %q: %v", maddrStr, err)
			continue
		}

		ai, err := peer.AddrInfoFromP2pAddr(ma)
		if err != nil {
			log.Info("AddrInfoFromP2pAddr failed for %q: %v", maddrStr, err)
			continue
		}

		// Don't try to connect to ourselves.
		if ai.ID == h.ID() {
			continue
		}

		if err := h.Connect(ctx, *ai); err != nil {
			log.Info("chain connect to %s via %s failed: %v", ai.ID.String(), maddrStr, err)
		} else {
			log.Info("connected (chain) to %s via %s", ai.ID.String(), maddrStr)
		}
	}
}

// -------------------- PubSub + Catchup --------------------

func writeJSON(w io.Writer, v any) error {
	enc := json.NewEncoder(w)
	return enc.Encode(v)
}

func readJSON(r io.Reader, v any) error {
	dec := json.NewDecoder(r)
	return dec.Decode(v)
}

func serveCatchup(cache *RoundCache, log *Logger) func(network.Stream) {
	return func(s network.Stream) {
		defer s.Close()

		_ = s.SetReadDeadline(time.Now().Add(catchupRequestTimeout))
		_ = s.SetWriteDeadline(time.Now().Add(catchupRequestTimeout))

		var req CatchupRequest
		if err := readJSON(s, &req); err != nil {
			log.Debug("catchup read error: %v", err)
			return
		}

		msgs := cache.GetRound(req.Round)
		resp := CatchupResponse{Round: req.Round, Messages: msgs}

		if err := writeJSON(s, &resp); err != nil {
			log.Debug("catchup write error: %v", err)
			return
		}

		log.Debug("served catchup for round %d with %d msg(s)", req.Round, len(msgs))
	}
}

func requestCatchup(ctx context.Context, h hostcore.Host, cache *RoundCache, log *Logger, pid peer.ID, round int) {
	ctx, cancel := context.WithTimeout(ctx, catchupRequestTimeout)
	defer cancel()

	s, err := h.NewStream(ctx, pid, catchupProtocol)
	if err != nil {
		log.Debug("catchup stream open fail %s: %v", pid.String(), err)
		return
	}
	defer s.Close()

	if err := writeJSON(s, CatchupRequest{Round: round}); err != nil {
		log.Debug("catchup request write fail: %v", err)
		return
	}

	var resp CatchupResponse
	if err := readJSON(bufio.NewReader(s), &resp); err != nil {
		log.Debug("catchup response read fail: %v", err)
		return
	}

	merged := 0
	for _, m := range resp.Messages {
		added, _ := cache.Upsert(m)
		if added {
			merged++
		}
	}

	if merged > 0 {
		log.Info("catchup from %s round %d merged %d msg(s)", pid.String(), round, merged)
	}
}

func publishOwn(ctx context.Context, topic *pubsub.Topic, cfg Config, log *Logger) {
	msg := RoundMsg{
		Round:    cfg.RoundID,
		Provider: cfg.ProviderID,
		Node:     cfg.NodeName,
		TsUnix:   time.Now().Unix(),
		Payload:  fmt.Sprintf("hello from %s", cfg.NodeName),
	}

	b, _ := json.Marshal(msg)
	if err := topic.Publish(ctx, b); err != nil {
		log.Warn("publish failed: %v", err)
		return
	}

	log.Info("published round=%d provider=%s", msg.Round, msg.Provider)
}

// deterministicPublishDelay gives stable, non-simultaneous publish timing per node.
func deterministicPublishDelay(node string) time.Duration {
	// 200ms base + 0..300ms deterministic jitter from node name.
	sum := sha256.Sum256([]byte("publish-jitter::" + node))
	j := int(sum[0])<<8 | int(sum[1]) // 0..65535
	jitterMs := j % 301               // 0..300
	return 200*time.Millisecond + time.Duration(jitterMs)*time.Millisecond
}

// -------------------- Main --------------------

func main() {
	// Local P2P config
	cfg := loadConfig()
	log := NewLogger(cfg.LogLevel, cfg.NodeName)
	ctx := context.Background()

	// Chain config (required now – no fallback)
	nodeCfg, err := nodecfg.Load()
	if err != nil {
		log.Error("chain config error (internal/config.Load): %v", err)
		os.Exit(1)
	}

	regClient, err := chainpkg.NewETHRegistryClient(nodeCfg.Chain)
	if err != nil {
		log.Error("chain client init error: %v", err)
		os.Exit(1)
	}
	log.Info("chain registry client initialized (RPC=%s)", nodeCfg.Chain.RPCURL)

	priv, err := loadOrCreatePrivKey(cfg, log)
	if err != nil {
		log.Error("identity error: %v", err)
		os.Exit(1)
	}

	h, err := libp2p.New(
		libp2p.Identity(priv),
		libp2p.ListenAddrStrings(
			fmt.Sprintf("/ip4/0.0.0.0/tcp/%d", cfg.ListenPort),
		),
	)
	if err != nil {
		log.Error("libp2p new host error: %v", err)
		os.Exit(1)
	}
	defer h.Close()

	log.Info("libp2p host started")
	log.Info("peer id: %s", h.ID().String())

	cache := NewRoundCache()
	h.SetStreamHandler(catchupProtocol, serveCatchup(cache, log))

	// Committee size is just for "ROUND COMPLETE" logging.
	committeeSize := len(cfg.CommitteeOrder)
	if committeeSize == 0 {
		committeeSize = 1
	}
	var roundCompleteOnce sync.Once

	// On-chain registration + discovery
	go func() {
		regCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
		defer cancel()

		// Build external multiaddr for this host.
		// Prefer explicit P2P_EXTERNAL_MULTIADDR from config;
		// but if it's empty or still has the placeholder peer ID, derive one.
		regMultiaddr := nodeCfg.P2P.ExternalMultiaddr

		if regMultiaddr == "" || strings.Contains(regMultiaddr, "YourPeerId") {
			externalHost := envStr("P2P_EXTERNAL_HOST", "127.0.0.1")
			regMultiaddr = fmt.Sprintf(
				"/ip4/%s/tcp/%d/p2p/%s",
				externalHost,
				cfg.ListenPort,
				h.ID().String(),
			)
		}

		log.Info("registering peer on-chain:")
		log.Info("  nodeName=%s", nodeCfg.P2P.NodeName)
		log.Info("  multiaddr=%s", regMultiaddr)

		if err := regClient.RegisterPeer(regCtx, nodeCfg.P2P.NodeName, regMultiaddr); err != nil {
			log.Error("RegisterPeer on-chain failed: %v", err)
			return
		}

		// For now, rely on registerPeer setting active = true.
		// setActive(true) can be used later for explicit deactivate/heartbeat.

		log.Info("waiting a few seconds for on-chain txs to confirm...")
		time.Sleep(15 * time.Second)

		// Discover & dial active peers from chain (only discovery mechanism now)
		connectActiveFromRegistry(regCtx, h, log, regClient)
	}()

	ps, err := pubsub.NewGossipSub(ctx, h)
	if err != nil {
		log.Error("pubsub init error: %v", err)
		os.Exit(1)
	}

	topic, err := ps.Join(cfg.TopicName)
	if err != nil {
		log.Error("topic join error: %v", err)
		os.Exit(1)
	}

	sub, err := topic.Subscribe()
	if err != nil {
		log.Error("topic subscribe error: %v", err)
		os.Exit(1)
	}
	log.Info("subscribed to topic %q", cfg.TopicName)

	// Publish with stable jitter so all nodes don't fire at the exact same moment.
	go func() {
		time.Sleep(deterministicPublishDelay(cfg.NodeName))
		publishOwn(ctx, topic, cfg, log)

		// Also insert our own message into cache immediately for local completeness.
		cache.Upsert(RoundMsg{
			Round:    cfg.RoundID,
			Provider: cfg.ProviderID,
			Node:     cfg.NodeName,
			TsUnix:   time.Now().Unix(),
			Payload:  fmt.Sprintf("hello from %s", cfg.NodeName),
		})
	}()

	// Read incoming pubsub messages.
	go func() {
		for {
			msg, err := sub.Next(ctx)
			if err != nil {
				return
			}

			// Ignore our own echoed message.
			if msg.ReceivedFrom == h.ID() {
				continue
			}

			var rm RoundMsg
			if err := json.Unmarshal(msg.Data, &rm); err != nil {
				log.Debug("bad msg json: %v", err)
				continue
			}

			added, count := cache.Upsert(rm)
			if added {
				log.Info("received NEW provider=%s round=%d via %s", rm.Provider, rm.Round, msg.ReceivedFrom.String())

				if rm.Round == cfg.RoundID && count >= committeeSize {
					roundCompleteOnce.Do(func() {
						providers := cache.Providers(cfg.RoundID)
						log.Info("ROUND COMPLETE round=%d (%d/%d): %s",
							cfg.RoundID, len(providers), committeeSize, strings.Join(providers, ", "),
						)
					})
				}
			}
		}
	}()

	// Optional: short debug status ticker to aid early iteration without log spam.
	go func() {
		if strings.ToLower(cfg.LogLevel) != "debug" {
			return
		}
		t := time.NewTicker(500 * time.Millisecond)
		defer t.Stop()

		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			<-t.C
			count := cache.Count(cfg.RoundID)
			if count > 0 {
				log.Debug("status round=%d cache=%d/%d", cfg.RoundID, count, committeeSize)
			}
		}
	}()

	// Catchup phase: just use whatever peers we are connected to (from chain discovery).
	go func() {
		time.Sleep(500 * time.Millisecond)

		peers := h.Network().Peers()
		for _, pid := range peers {
			if pid == h.ID() {
				continue
			}
			requestCatchup(ctx, h, cache, log, pid, cfg.RoundID)
		}

		// Final summary after a short pause
		time.Sleep(400 * time.Millisecond)
		msgs := cache.GetRound(cfg.RoundID)
		if len(msgs) > 0 {
			log.Info("round %d cache has %d/%d provider msg(s)", cfg.RoundID, len(msgs), committeeSize)

			if len(msgs) >= committeeSize {
				roundCompleteOnce.Do(func() {
					providers := cache.Providers(cfg.RoundID)
					log.Info("ROUND COMPLETE round=%d (%d/%d): %s",
						cfg.RoundID, len(providers), committeeSize, strings.Join(providers, ", "),
					)
				})
			}
		}
	}()

	select {}
}
