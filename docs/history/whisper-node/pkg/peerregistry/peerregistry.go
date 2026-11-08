// Code generated - DO NOT EDIT.
// This file is a generated binding and any manual changes will be lost.

package peerregistry

import (
	"errors"
	"math/big"
	"strings"

	ethereum "github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/event"
)

// Reference imports to suppress errors if they are not otherwise used.
var (
	_ = errors.New
	_ = big.NewInt
	_ = strings.NewReader
	_ = ethereum.NotFound
	_ = bind.Bind
	_ = common.Big1
	_ = types.BloomLookup
	_ = event.NewSubscription
	_ = abi.ConvertType
)

// PeerRegistryPeerInfo is an auto generated low-level Go binding around an user-defined struct.
type PeerRegistryPeerInfo struct {
	NodeName  string
	Multiaddr string
	LastSeen  uint64
	Active    bool
}

// PeerregistryMetaData contains all meta data concerning the Peerregistry contract.
var PeerregistryMetaData = &bind.MetaData{
	ABI: "[{\"inputs\":[{\"internalType\":\"address\",\"name\":\"peer\",\"type\":\"address\",\"indexed\":true},{\"internalType\":\"string\",\"name\":\"nodeName\",\"type\":\"string\",\"indexed\":false},{\"internalType\":\"string\",\"name\":\"multiaddr\",\"type\":\"string\",\"indexed\":false},{\"internalType\":\"uint64\",\"name\":\"lastSeen\",\"type\":\"uint64\",\"indexed\":false}],\"type\":\"event\",\"name\":\"PeerRegistered\",\"anonymous\":false},{\"inputs\":[{\"internalType\":\"address\",\"name\":\"peer\",\"type\":\"address\",\"indexed\":true},{\"internalType\":\"bool\",\"name\":\"active\",\"type\":\"bool\",\"indexed\":false},{\"internalType\":\"uint64\",\"name\":\"lastSeen\",\"type\":\"uint64\",\"indexed\":false}],\"type\":\"event\",\"name\":\"PeerStatusUpdated\",\"anonymous\":false},{\"inputs\":[{\"internalType\":\"uint256\",\"name\":\"roundId\",\"type\":\"uint256\",\"indexed\":true},{\"internalType\":\"address\",\"name\":\"creator\",\"type\":\"address\",\"indexed\":true},{\"internalType\":\"address[]\",\"name\":\"participants\",\"type\":\"address[]\",\"indexed\":false}],\"type\":\"event\",\"name\":\"RoundCreated\",\"anonymous\":false},{\"inputs\":[{\"internalType\":\"uint256\",\"name\":\"roundId\",\"type\":\"uint256\",\"indexed\":true},{\"internalType\":\"address\",\"name\":\"submitter\",\"type\":\"address\",\"indexed\":true},{\"internalType\":\"bytes32\",\"name\":\"result\",\"type\":\"bytes32\",\"indexed\":false}],\"type\":\"event\",\"name\":\"RoundResultSubmitted\",\"anonymous\":false},{\"inputs\":[{\"internalType\":\"uint256\",\"name\":\"maxParticipants\",\"type\":\"uint256\"}],\"stateMutability\":\"nonpayable\",\"type\":\"function\",\"name\":\"createRoundFromActivePeers\",\"outputs\":[{\"internalType\":\"uint256\",\"name\":\"roundId\",\"type\":\"uint256\"},{\"internalType\":\"address[]\",\"name\":\"participants\",\"type\":\"address[]\"}]},{\"inputs\":[],\"stateMutability\":\"view\",\"type\":\"function\",\"name\":\"getActivePeers\",\"outputs\":[{\"internalType\":\"address[]\",\"name\":\"peers\",\"type\":\"address[]\"},{\"internalType\":\"structPeerRegistry.PeerInfo[]\",\"name\":\"infos\",\"type\":\"tuple[]\",\"components\":[{\"internalType\":\"string\",\"name\":\"nodeName\",\"type\":\"string\"},{\"internalType\":\"string\",\"name\":\"multiaddr\",\"type\":\"string\"},{\"internalType\":\"uint64\",\"name\":\"lastSeen\",\"type\":\"uint64\"},{\"internalType\":\"bool\",\"name\":\"active\",\"type\":\"bool\"}]}]},{\"inputs\":[],\"stateMutability\":\"view\",\"type\":\"function\",\"name\":\"getAllPeers\",\"outputs\":[{\"internalType\":\"address[]\",\"name\":\"peers\",\"type\":\"address[]\"},{\"internalType\":\"structPeerRegistry.PeerInfo[]\",\"name\":\"infos\",\"type\":\"tuple[]\",\"components\":[{\"internalType\":\"string\",\"name\":\"nodeName\",\"type\":\"string\"},{\"internalType\":\"string\",\"name\":\"multiaddr\",\"type\":\"string\"},{\"internalType\":\"uint64\",\"name\":\"lastSeen\",\"type\":\"uint64\"},{\"internalType\":\"bool\",\"name\":\"active\",\"type\":\"bool\"}]}]},{\"inputs\":[{\"internalType\":\"address\",\"name\":\"peer\",\"type\":\"address\"}],\"stateMutability\":\"view\",\"type\":\"function\",\"name\":\"getPeer\",\"outputs\":[{\"internalType\":\"structPeerRegistry.PeerInfo\",\"name\":\"\",\"type\":\"tuple\",\"components\":[{\"internalType\":\"string\",\"name\":\"nodeName\",\"type\":\"string\"},{\"internalType\":\"string\",\"name\":\"multiaddr\",\"type\":\"string\"},{\"internalType\":\"uint64\",\"name\":\"lastSeen\",\"type\":\"uint64\"},{\"internalType\":\"bool\",\"name\":\"active\",\"type\":\"bool\"}]}]},{\"inputs\":[{\"internalType\":\"uint256\",\"name\":\"roundId\",\"type\":\"uint256\"}],\"stateMutability\":\"view\",\"type\":\"function\",\"name\":\"getRound\",\"outputs\":[{\"internalType\":\"uint256\",\"name\":\"id\",\"type\":\"uint256\"},{\"internalType\":\"address\",\"name\":\"creator\",\"type\":\"address\"},{\"internalType\":\"address[]\",\"name\":\"participants\",\"type\":\"address[]\"},{\"internalType\":\"uint64\",\"name\":\"createdAt\",\"type\":\"uint64\"},{\"internalType\":\"bool\",\"name\":\"active\",\"type\":\"bool\"},{\"internalType\":\"bytes32\",\"name\":\"result\",\"type\":\"bytes32\"}]},{\"inputs\":[{\"internalType\":\"string\",\"name\":\"nodeName\",\"type\":\"string\"},{\"internalType\":\"string\",\"name\":\"multiaddr\",\"type\":\"string\"}],\"stateMutability\":\"nonpayable\",\"type\":\"function\",\"name\":\"registerPeer\"},{\"inputs\":[{\"internalType\":\"bool\",\"name\":\"active\",\"type\":\"bool\"}],\"stateMutability\":\"nonpayable\",\"type\":\"function\",\"name\":\"setActive\"},{\"inputs\":[{\"internalType\":\"uint256\",\"name\":\"roundId\",\"type\":\"uint256\"},{\"internalType\":\"bytes32\",\"name\":\"result\",\"type\":\"bytes32\"}],\"stateMutability\":\"nonpayable\",\"type\":\"function\",\"name\":\"submitRoundResult\"}]",
}

// PeerregistryABI is the input ABI used to generate the binding from.
// Deprecated: Use PeerregistryMetaData.ABI instead.
var PeerregistryABI = PeerregistryMetaData.ABI

// Peerregistry is an auto generated Go binding around an Ethereum contract.
type Peerregistry struct {
	PeerregistryCaller     // Read-only binding to the contract
	PeerregistryTransactor // Write-only binding to the contract
	PeerregistryFilterer   // Log filterer for contract events
}

// PeerregistryCaller is an auto generated read-only Go binding around an Ethereum contract.
type PeerregistryCaller struct {
	contract *bind.BoundContract // Generic contract wrapper for the low level calls
}

// PeerregistryTransactor is an auto generated write-only Go binding around an Ethereum contract.
type PeerregistryTransactor struct {
	contract *bind.BoundContract // Generic contract wrapper for the low level calls
}

// PeerregistryFilterer is an auto generated log filtering Go binding around an Ethereum contract events.
type PeerregistryFilterer struct {
	contract *bind.BoundContract // Generic contract wrapper for the low level calls
}

// PeerregistrySession is an auto generated Go binding around an Ethereum contract,
// with pre-set call and transact options.
type PeerregistrySession struct {
	Contract     *Peerregistry     // Generic contract binding to set the session for
	CallOpts     bind.CallOpts     // Call options to use throughout this session
	TransactOpts bind.TransactOpts // Transaction auth options to use throughout this session
}

// PeerregistryCallerSession is an auto generated read-only Go binding around an Ethereum contract,
// with pre-set call options.
type PeerregistryCallerSession struct {
	Contract *PeerregistryCaller // Generic contract caller binding to set the session for
	CallOpts bind.CallOpts       // Call options to use throughout this session
}

// PeerregistryTransactorSession is an auto generated write-only Go binding around an Ethereum contract,
// with pre-set transact options.
type PeerregistryTransactorSession struct {
	Contract     *PeerregistryTransactor // Generic contract transactor binding to set the session for
	TransactOpts bind.TransactOpts       // Transaction auth options to use throughout this session
}

// PeerregistryRaw is an auto generated low-level Go binding around an Ethereum contract.
type PeerregistryRaw struct {
	Contract *Peerregistry // Generic contract binding to access the raw methods on
}

// PeerregistryCallerRaw is an auto generated low-level read-only Go binding around an Ethereum contract.
type PeerregistryCallerRaw struct {
	Contract *PeerregistryCaller // Generic read-only contract binding to access the raw methods on
}

// PeerregistryTransactorRaw is an auto generated low-level write-only Go binding around an Ethereum contract.
type PeerregistryTransactorRaw struct {
	Contract *PeerregistryTransactor // Generic write-only contract binding to access the raw methods on
}

// NewPeerregistry creates a new instance of Peerregistry, bound to a specific deployed contract.
func NewPeerregistry(address common.Address, backend bind.ContractBackend) (*Peerregistry, error) {
	contract, err := bindPeerregistry(address, backend, backend, backend)
	if err != nil {
		return nil, err
	}
	return &Peerregistry{PeerregistryCaller: PeerregistryCaller{contract: contract}, PeerregistryTransactor: PeerregistryTransactor{contract: contract}, PeerregistryFilterer: PeerregistryFilterer{contract: contract}}, nil
}

// NewPeerregistryCaller creates a new read-only instance of Peerregistry, bound to a specific deployed contract.
func NewPeerregistryCaller(address common.Address, caller bind.ContractCaller) (*PeerregistryCaller, error) {
	contract, err := bindPeerregistry(address, caller, nil, nil)
	if err != nil {
		return nil, err
	}
	return &PeerregistryCaller{contract: contract}, nil
}

// NewPeerregistryTransactor creates a new write-only instance of Peerregistry, bound to a specific deployed contract.
func NewPeerregistryTransactor(address common.Address, transactor bind.ContractTransactor) (*PeerregistryTransactor, error) {
	contract, err := bindPeerregistry(address, nil, transactor, nil)
	if err != nil {
		return nil, err
	}
	return &PeerregistryTransactor{contract: contract}, nil
}

// NewPeerregistryFilterer creates a new log filterer instance of Peerregistry, bound to a specific deployed contract.
func NewPeerregistryFilterer(address common.Address, filterer bind.ContractFilterer) (*PeerregistryFilterer, error) {
	contract, err := bindPeerregistry(address, nil, nil, filterer)
	if err != nil {
		return nil, err
	}
	return &PeerregistryFilterer{contract: contract}, nil
}

// bindPeerregistry binds a generic wrapper to an already deployed contract.
func bindPeerregistry(address common.Address, caller bind.ContractCaller, transactor bind.ContractTransactor, filterer bind.ContractFilterer) (*bind.BoundContract, error) {
	parsed, err := PeerregistryMetaData.GetAbi()
	if err != nil {
		return nil, err
	}
	return bind.NewBoundContract(address, *parsed, caller, transactor, filterer), nil
}

// Call invokes the (constant) contract method with params as input values and
// sets the output to result. The result type might be a single field for simple
// returns, a slice of interfaces for anonymous returns and a struct for named
// returns.
func (_Peerregistry *PeerregistryRaw) Call(opts *bind.CallOpts, result *[]interface{}, method string, params ...interface{}) error {
	return _Peerregistry.Contract.PeerregistryCaller.contract.Call(opts, result, method, params...)
}

// Transfer initiates a plain transaction to move funds to the contract, calling
// its default method if one is available.
func (_Peerregistry *PeerregistryRaw) Transfer(opts *bind.TransactOpts) (*types.Transaction, error) {
	return _Peerregistry.Contract.PeerregistryTransactor.contract.Transfer(opts)
}

// Transact invokes the (paid) contract method with params as input values.
func (_Peerregistry *PeerregistryRaw) Transact(opts *bind.TransactOpts, method string, params ...interface{}) (*types.Transaction, error) {
	return _Peerregistry.Contract.PeerregistryTransactor.contract.Transact(opts, method, params...)
}

// Call invokes the (constant) contract method with params as input values and
// sets the output to result. The result type might be a single field for simple
// returns, a slice of interfaces for anonymous returns and a struct for named
// returns.
func (_Peerregistry *PeerregistryCallerRaw) Call(opts *bind.CallOpts, result *[]interface{}, method string, params ...interface{}) error {
	return _Peerregistry.Contract.contract.Call(opts, result, method, params...)
}

// Transfer initiates a plain transaction to move funds to the contract, calling
// its default method if one is available.
func (_Peerregistry *PeerregistryTransactorRaw) Transfer(opts *bind.TransactOpts) (*types.Transaction, error) {
	return _Peerregistry.Contract.contract.Transfer(opts)
}

// Transact invokes the (paid) contract method with params as input values.
func (_Peerregistry *PeerregistryTransactorRaw) Transact(opts *bind.TransactOpts, method string, params ...interface{}) (*types.Transaction, error) {
	return _Peerregistry.Contract.contract.Transact(opts, method, params...)
}

// GetActivePeers is a free data retrieval call binding the contract method 0x614fc7bc.
//
// Solidity: function getActivePeers() view returns(address[] peers, (string,string,uint64,bool)[] infos)
func (_Peerregistry *PeerregistryCaller) GetActivePeers(opts *bind.CallOpts) (struct {
	Peers []common.Address
	Infos []PeerRegistryPeerInfo
}, error) {
	var out []interface{}
	err := _Peerregistry.contract.Call(opts, &out, "getActivePeers")

	outstruct := new(struct {
		Peers []common.Address
		Infos []PeerRegistryPeerInfo
	})
	if err != nil {
		return *outstruct, err
	}

	outstruct.Peers = *abi.ConvertType(out[0], new([]common.Address)).(*[]common.Address)
	outstruct.Infos = *abi.ConvertType(out[1], new([]PeerRegistryPeerInfo)).(*[]PeerRegistryPeerInfo)

	return *outstruct, err

}

// GetActivePeers is a free data retrieval call binding the contract method 0x614fc7bc.
//
// Solidity: function getActivePeers() view returns(address[] peers, (string,string,uint64,bool)[] infos)
func (_Peerregistry *PeerregistrySession) GetActivePeers() (struct {
	Peers []common.Address
	Infos []PeerRegistryPeerInfo
}, error) {
	return _Peerregistry.Contract.GetActivePeers(&_Peerregistry.CallOpts)
}

// GetActivePeers is a free data retrieval call binding the contract method 0x614fc7bc.
//
// Solidity: function getActivePeers() view returns(address[] peers, (string,string,uint64,bool)[] infos)
func (_Peerregistry *PeerregistryCallerSession) GetActivePeers() (struct {
	Peers []common.Address
	Infos []PeerRegistryPeerInfo
}, error) {
	return _Peerregistry.Contract.GetActivePeers(&_Peerregistry.CallOpts)
}

// GetAllPeers is a free data retrieval call binding the contract method 0x2d62b810.
//
// Solidity: function getAllPeers() view returns(address[] peers, (string,string,uint64,bool)[] infos)
func (_Peerregistry *PeerregistryCaller) GetAllPeers(opts *bind.CallOpts) (struct {
	Peers []common.Address
	Infos []PeerRegistryPeerInfo
}, error) {
	var out []interface{}
	err := _Peerregistry.contract.Call(opts, &out, "getAllPeers")

	outstruct := new(struct {
		Peers []common.Address
		Infos []PeerRegistryPeerInfo
	})
	if err != nil {
		return *outstruct, err
	}

	outstruct.Peers = *abi.ConvertType(out[0], new([]common.Address)).(*[]common.Address)
	outstruct.Infos = *abi.ConvertType(out[1], new([]PeerRegistryPeerInfo)).(*[]PeerRegistryPeerInfo)

	return *outstruct, err

}

// GetAllPeers is a free data retrieval call binding the contract method 0x2d62b810.
//
// Solidity: function getAllPeers() view returns(address[] peers, (string,string,uint64,bool)[] infos)
func (_Peerregistry *PeerregistrySession) GetAllPeers() (struct {
	Peers []common.Address
	Infos []PeerRegistryPeerInfo
}, error) {
	return _Peerregistry.Contract.GetAllPeers(&_Peerregistry.CallOpts)
}

// GetAllPeers is a free data retrieval call binding the contract method 0x2d62b810.
//
// Solidity: function getAllPeers() view returns(address[] peers, (string,string,uint64,bool)[] infos)
func (_Peerregistry *PeerregistryCallerSession) GetAllPeers() (struct {
	Peers []common.Address
	Infos []PeerRegistryPeerInfo
}, error) {
	return _Peerregistry.Contract.GetAllPeers(&_Peerregistry.CallOpts)
}

// GetPeer is a free data retrieval call binding the contract method 0xe7b6dd16.
//
// Solidity: function getPeer(address peer) view returns((string,string,uint64,bool))
func (_Peerregistry *PeerregistryCaller) GetPeer(opts *bind.CallOpts, peer common.Address) (PeerRegistryPeerInfo, error) {
	var out []interface{}
	err := _Peerregistry.contract.Call(opts, &out, "getPeer", peer)

	if err != nil {
		return *new(PeerRegistryPeerInfo), err
	}

	out0 := *abi.ConvertType(out[0], new(PeerRegistryPeerInfo)).(*PeerRegistryPeerInfo)

	return out0, err

}

// GetPeer is a free data retrieval call binding the contract method 0xe7b6dd16.
//
// Solidity: function getPeer(address peer) view returns((string,string,uint64,bool))
func (_Peerregistry *PeerregistrySession) GetPeer(peer common.Address) (PeerRegistryPeerInfo, error) {
	return _Peerregistry.Contract.GetPeer(&_Peerregistry.CallOpts, peer)
}

// GetPeer is a free data retrieval call binding the contract method 0xe7b6dd16.
//
// Solidity: function getPeer(address peer) view returns((string,string,uint64,bool))
func (_Peerregistry *PeerregistryCallerSession) GetPeer(peer common.Address) (PeerRegistryPeerInfo, error) {
	return _Peerregistry.Contract.GetPeer(&_Peerregistry.CallOpts, peer)
}

// GetRound is a free data retrieval call binding the contract method 0x8f1327c0.
//
// Solidity: function getRound(uint256 roundId) view returns(uint256 id, address creator, address[] participants, uint64 createdAt, bool active, bytes32 result)
func (_Peerregistry *PeerregistryCaller) GetRound(opts *bind.CallOpts, roundId *big.Int) (struct {
	Id           *big.Int
	Creator      common.Address
	Participants []common.Address
	CreatedAt    uint64
	Active       bool
	Result       [32]byte
}, error) {
	var out []interface{}
	err := _Peerregistry.contract.Call(opts, &out, "getRound", roundId)

	outstruct := new(struct {
		Id           *big.Int
		Creator      common.Address
		Participants []common.Address
		CreatedAt    uint64
		Active       bool
		Result       [32]byte
	})
	if err != nil {
		return *outstruct, err
	}

	outstruct.Id = *abi.ConvertType(out[0], new(*big.Int)).(**big.Int)
	outstruct.Creator = *abi.ConvertType(out[1], new(common.Address)).(*common.Address)
	outstruct.Participants = *abi.ConvertType(out[2], new([]common.Address)).(*[]common.Address)
	outstruct.CreatedAt = *abi.ConvertType(out[3], new(uint64)).(*uint64)
	outstruct.Active = *abi.ConvertType(out[4], new(bool)).(*bool)
	outstruct.Result = *abi.ConvertType(out[5], new([32]byte)).(*[32]byte)

	return *outstruct, err

}

// GetRound is a free data retrieval call binding the contract method 0x8f1327c0.
//
// Solidity: function getRound(uint256 roundId) view returns(uint256 id, address creator, address[] participants, uint64 createdAt, bool active, bytes32 result)
func (_Peerregistry *PeerregistrySession) GetRound(roundId *big.Int) (struct {
	Id           *big.Int
	Creator      common.Address
	Participants []common.Address
	CreatedAt    uint64
	Active       bool
	Result       [32]byte
}, error) {
	return _Peerregistry.Contract.GetRound(&_Peerregistry.CallOpts, roundId)
}

// GetRound is a free data retrieval call binding the contract method 0x8f1327c0.
//
// Solidity: function getRound(uint256 roundId) view returns(uint256 id, address creator, address[] participants, uint64 createdAt, bool active, bytes32 result)
func (_Peerregistry *PeerregistryCallerSession) GetRound(roundId *big.Int) (struct {
	Id           *big.Int
	Creator      common.Address
	Participants []common.Address
	CreatedAt    uint64
	Active       bool
	Result       [32]byte
}, error) {
	return _Peerregistry.Contract.GetRound(&_Peerregistry.CallOpts, roundId)
}

// CreateRoundFromActivePeers is a paid mutator transaction binding the contract method 0x7e818f69.
//
// Solidity: function createRoundFromActivePeers(uint256 maxParticipants) returns(uint256 roundId, address[] participants)
func (_Peerregistry *PeerregistryTransactor) CreateRoundFromActivePeers(opts *bind.TransactOpts, maxParticipants *big.Int) (*types.Transaction, error) {
	return _Peerregistry.contract.Transact(opts, "createRoundFromActivePeers", maxParticipants)
}

// CreateRoundFromActivePeers is a paid mutator transaction binding the contract method 0x7e818f69.
//
// Solidity: function createRoundFromActivePeers(uint256 maxParticipants) returns(uint256 roundId, address[] participants)
func (_Peerregistry *PeerregistrySession) CreateRoundFromActivePeers(maxParticipants *big.Int) (*types.Transaction, error) {
	return _Peerregistry.Contract.CreateRoundFromActivePeers(&_Peerregistry.TransactOpts, maxParticipants)
}

// CreateRoundFromActivePeers is a paid mutator transaction binding the contract method 0x7e818f69.
//
// Solidity: function createRoundFromActivePeers(uint256 maxParticipants) returns(uint256 roundId, address[] participants)
func (_Peerregistry *PeerregistryTransactorSession) CreateRoundFromActivePeers(maxParticipants *big.Int) (*types.Transaction, error) {
	return _Peerregistry.Contract.CreateRoundFromActivePeers(&_Peerregistry.TransactOpts, maxParticipants)
}

// RegisterPeer is a paid mutator transaction binding the contract method 0x212b21ce.
//
// Solidity: function registerPeer(string nodeName, string multiaddr) returns()
func (_Peerregistry *PeerregistryTransactor) RegisterPeer(opts *bind.TransactOpts, nodeName string, multiaddr string) (*types.Transaction, error) {
	return _Peerregistry.contract.Transact(opts, "registerPeer", nodeName, multiaddr)
}

// RegisterPeer is a paid mutator transaction binding the contract method 0x212b21ce.
//
// Solidity: function registerPeer(string nodeName, string multiaddr) returns()
func (_Peerregistry *PeerregistrySession) RegisterPeer(nodeName string, multiaddr string) (*types.Transaction, error) {
	return _Peerregistry.Contract.RegisterPeer(&_Peerregistry.TransactOpts, nodeName, multiaddr)
}

// RegisterPeer is a paid mutator transaction binding the contract method 0x212b21ce.
//
// Solidity: function registerPeer(string nodeName, string multiaddr) returns()
func (_Peerregistry *PeerregistryTransactorSession) RegisterPeer(nodeName string, multiaddr string) (*types.Transaction, error) {
	return _Peerregistry.Contract.RegisterPeer(&_Peerregistry.TransactOpts, nodeName, multiaddr)
}

// SetActive is a paid mutator transaction binding the contract method 0xacec338a.
//
// Solidity: function setActive(bool active) returns()
func (_Peerregistry *PeerregistryTransactor) SetActive(opts *bind.TransactOpts, active bool) (*types.Transaction, error) {
	return _Peerregistry.contract.Transact(opts, "setActive", active)
}

// SetActive is a paid mutator transaction binding the contract method 0xacec338a.
//
// Solidity: function setActive(bool active) returns()
func (_Peerregistry *PeerregistrySession) SetActive(active bool) (*types.Transaction, error) {
	return _Peerregistry.Contract.SetActive(&_Peerregistry.TransactOpts, active)
}

// SetActive is a paid mutator transaction binding the contract method 0xacec338a.
//
// Solidity: function setActive(bool active) returns()
func (_Peerregistry *PeerregistryTransactorSession) SetActive(active bool) (*types.Transaction, error) {
	return _Peerregistry.Contract.SetActive(&_Peerregistry.TransactOpts, active)
}

// SubmitRoundResult is a paid mutator transaction binding the contract method 0xd2f9dcac.
//
// Solidity: function submitRoundResult(uint256 roundId, bytes32 result) returns()
func (_Peerregistry *PeerregistryTransactor) SubmitRoundResult(opts *bind.TransactOpts, roundId *big.Int, result [32]byte) (*types.Transaction, error) {
	return _Peerregistry.contract.Transact(opts, "submitRoundResult", roundId, result)
}

// SubmitRoundResult is a paid mutator transaction binding the contract method 0xd2f9dcac.
//
// Solidity: function submitRoundResult(uint256 roundId, bytes32 result) returns()
func (_Peerregistry *PeerregistrySession) SubmitRoundResult(roundId *big.Int, result [32]byte) (*types.Transaction, error) {
	return _Peerregistry.Contract.SubmitRoundResult(&_Peerregistry.TransactOpts, roundId, result)
}

// SubmitRoundResult is a paid mutator transaction binding the contract method 0xd2f9dcac.
//
// Solidity: function submitRoundResult(uint256 roundId, bytes32 result) returns()
func (_Peerregistry *PeerregistryTransactorSession) SubmitRoundResult(roundId *big.Int, result [32]byte) (*types.Transaction, error) {
	return _Peerregistry.Contract.SubmitRoundResult(&_Peerregistry.TransactOpts, roundId, result)
}

// PeerregistryPeerRegisteredIterator is returned from FilterPeerRegistered and is used to iterate over the raw logs and unpacked data for PeerRegistered events raised by the Peerregistry contract.
type PeerregistryPeerRegisteredIterator struct {
	Event *PeerregistryPeerRegistered // Event containing the contract specifics and raw log

	contract *bind.BoundContract // Generic contract to use for unpacking event data
	event    string              // Event name to use for unpacking event data

	logs chan types.Log        // Log channel receiving the found contract events
	sub  ethereum.Subscription // Subscription for errors, completion and termination
	done bool                  // Whether the subscription completed delivering logs
	fail error                 // Occurred error to stop iteration
}

// Next advances the iterator to the subsequent event, returning whether there
// are any more events found. In case of a retrieval or parsing error, false is
// returned and Error() can be queried for the exact failure.
func (it *PeerregistryPeerRegisteredIterator) Next() bool {
	// If the iterator failed, stop iterating
	if it.fail != nil {
		return false
	}
	// If the iterator completed, deliver directly whatever's available
	if it.done {
		select {
		case log := <-it.logs:
			it.Event = new(PeerregistryPeerRegistered)
			if err := it.contract.UnpackLog(it.Event, it.event, log); err != nil {
				it.fail = err
				return false
			}
			it.Event.Raw = log
			return true

		default:
			return false
		}
	}
	// Iterator still in progress, wait for either a data or an error event
	select {
	case log := <-it.logs:
		it.Event = new(PeerregistryPeerRegistered)
		if err := it.contract.UnpackLog(it.Event, it.event, log); err != nil {
			it.fail = err
			return false
		}
		it.Event.Raw = log
		return true

	case err := <-it.sub.Err():
		it.done = true
		it.fail = err
		return it.Next()
	}
}

// Error returns any retrieval or parsing error occurred during filtering.
func (it *PeerregistryPeerRegisteredIterator) Error() error {
	return it.fail
}

// Close terminates the iteration process, releasing any pending underlying
// resources.
func (it *PeerregistryPeerRegisteredIterator) Close() error {
	it.sub.Unsubscribe()
	return nil
}

// PeerregistryPeerRegistered represents a PeerRegistered event raised by the Peerregistry contract.
type PeerregistryPeerRegistered struct {
	Peer      common.Address
	NodeName  string
	Multiaddr string
	LastSeen  uint64
	Raw       types.Log // Blockchain specific contextual infos
}

// FilterPeerRegistered is a free log retrieval operation binding the contract event 0x9f94ba0e2663736e39cf32f0d2aa4bda59e7f7842ad51f1232e0725692562646.
//
// Solidity: event PeerRegistered(address indexed peer, string nodeName, string multiaddr, uint64 lastSeen)
func (_Peerregistry *PeerregistryFilterer) FilterPeerRegistered(opts *bind.FilterOpts, peer []common.Address) (*PeerregistryPeerRegisteredIterator, error) {

	var peerRule []interface{}
	for _, peerItem := range peer {
		peerRule = append(peerRule, peerItem)
	}

	logs, sub, err := _Peerregistry.contract.FilterLogs(opts, "PeerRegistered", peerRule)
	if err != nil {
		return nil, err
	}
	return &PeerregistryPeerRegisteredIterator{contract: _Peerregistry.contract, event: "PeerRegistered", logs: logs, sub: sub}, nil
}

// WatchPeerRegistered is a free log subscription operation binding the contract event 0x9f94ba0e2663736e39cf32f0d2aa4bda59e7f7842ad51f1232e0725692562646.
//
// Solidity: event PeerRegistered(address indexed peer, string nodeName, string multiaddr, uint64 lastSeen)
func (_Peerregistry *PeerregistryFilterer) WatchPeerRegistered(opts *bind.WatchOpts, sink chan<- *PeerregistryPeerRegistered, peer []common.Address) (event.Subscription, error) {

	var peerRule []interface{}
	for _, peerItem := range peer {
		peerRule = append(peerRule, peerItem)
	}

	logs, sub, err := _Peerregistry.contract.WatchLogs(opts, "PeerRegistered", peerRule)
	if err != nil {
		return nil, err
	}
	return event.NewSubscription(func(quit <-chan struct{}) error {
		defer sub.Unsubscribe()
		for {
			select {
			case log := <-logs:
				// New log arrived, parse the event and forward to the user
				event := new(PeerregistryPeerRegistered)
				if err := _Peerregistry.contract.UnpackLog(event, "PeerRegistered", log); err != nil {
					return err
				}
				event.Raw = log

				select {
				case sink <- event:
				case err := <-sub.Err():
					return err
				case <-quit:
					return nil
				}
			case err := <-sub.Err():
				return err
			case <-quit:
				return nil
			}
		}
	}), nil
}

// ParsePeerRegistered is a log parse operation binding the contract event 0x9f94ba0e2663736e39cf32f0d2aa4bda59e7f7842ad51f1232e0725692562646.
//
// Solidity: event PeerRegistered(address indexed peer, string nodeName, string multiaddr, uint64 lastSeen)
func (_Peerregistry *PeerregistryFilterer) ParsePeerRegistered(log types.Log) (*PeerregistryPeerRegistered, error) {
	event := new(PeerregistryPeerRegistered)
	if err := _Peerregistry.contract.UnpackLog(event, "PeerRegistered", log); err != nil {
		return nil, err
	}
	event.Raw = log
	return event, nil
}

// PeerregistryPeerStatusUpdatedIterator is returned from FilterPeerStatusUpdated and is used to iterate over the raw logs and unpacked data for PeerStatusUpdated events raised by the Peerregistry contract.
type PeerregistryPeerStatusUpdatedIterator struct {
	Event *PeerregistryPeerStatusUpdated // Event containing the contract specifics and raw log

	contract *bind.BoundContract // Generic contract to use for unpacking event data
	event    string              // Event name to use for unpacking event data

	logs chan types.Log        // Log channel receiving the found contract events
	sub  ethereum.Subscription // Subscription for errors, completion and termination
	done bool                  // Whether the subscription completed delivering logs
	fail error                 // Occurred error to stop iteration
}

// Next advances the iterator to the subsequent event, returning whether there
// are any more events found. In case of a retrieval or parsing error, false is
// returned and Error() can be queried for the exact failure.
func (it *PeerregistryPeerStatusUpdatedIterator) Next() bool {
	// If the iterator failed, stop iterating
	if it.fail != nil {
		return false
	}
	// If the iterator completed, deliver directly whatever's available
	if it.done {
		select {
		case log := <-it.logs:
			it.Event = new(PeerregistryPeerStatusUpdated)
			if err := it.contract.UnpackLog(it.Event, it.event, log); err != nil {
				it.fail = err
				return false
			}
			it.Event.Raw = log
			return true

		default:
			return false
		}
	}
	// Iterator still in progress, wait for either a data or an error event
	select {
	case log := <-it.logs:
		it.Event = new(PeerregistryPeerStatusUpdated)
		if err := it.contract.UnpackLog(it.Event, it.event, log); err != nil {
			it.fail = err
			return false
		}
		it.Event.Raw = log
		return true

	case err := <-it.sub.Err():
		it.done = true
		it.fail = err
		return it.Next()
	}
}

// Error returns any retrieval or parsing error occurred during filtering.
func (it *PeerregistryPeerStatusUpdatedIterator) Error() error {
	return it.fail
}

// Close terminates the iteration process, releasing any pending underlying
// resources.
func (it *PeerregistryPeerStatusUpdatedIterator) Close() error {
	it.sub.Unsubscribe()
	return nil
}

// PeerregistryPeerStatusUpdated represents a PeerStatusUpdated event raised by the Peerregistry contract.
type PeerregistryPeerStatusUpdated struct {
	Peer     common.Address
	Active   bool
	LastSeen uint64
	Raw      types.Log // Blockchain specific contextual infos
}

// FilterPeerStatusUpdated is a free log retrieval operation binding the contract event 0x72a76c75c9365c7b93ba1f1c87ea32f7fe3a11b1d613741a801205de7e99f84c.
//
// Solidity: event PeerStatusUpdated(address indexed peer, bool active, uint64 lastSeen)
func (_Peerregistry *PeerregistryFilterer) FilterPeerStatusUpdated(opts *bind.FilterOpts, peer []common.Address) (*PeerregistryPeerStatusUpdatedIterator, error) {

	var peerRule []interface{}
	for _, peerItem := range peer {
		peerRule = append(peerRule, peerItem)
	}

	logs, sub, err := _Peerregistry.contract.FilterLogs(opts, "PeerStatusUpdated", peerRule)
	if err != nil {
		return nil, err
	}
	return &PeerregistryPeerStatusUpdatedIterator{contract: _Peerregistry.contract, event: "PeerStatusUpdated", logs: logs, sub: sub}, nil
}

// WatchPeerStatusUpdated is a free log subscription operation binding the contract event 0x72a76c75c9365c7b93ba1f1c87ea32f7fe3a11b1d613741a801205de7e99f84c.
//
// Solidity: event PeerStatusUpdated(address indexed peer, bool active, uint64 lastSeen)
func (_Peerregistry *PeerregistryFilterer) WatchPeerStatusUpdated(opts *bind.WatchOpts, sink chan<- *PeerregistryPeerStatusUpdated, peer []common.Address) (event.Subscription, error) {

	var peerRule []interface{}
	for _, peerItem := range peer {
		peerRule = append(peerRule, peerItem)
	}

	logs, sub, err := _Peerregistry.contract.WatchLogs(opts, "PeerStatusUpdated", peerRule)
	if err != nil {
		return nil, err
	}
	return event.NewSubscription(func(quit <-chan struct{}) error {
		defer sub.Unsubscribe()
		for {
			select {
			case log := <-logs:
				// New log arrived, parse the event and forward to the user
				event := new(PeerregistryPeerStatusUpdated)
				if err := _Peerregistry.contract.UnpackLog(event, "PeerStatusUpdated", log); err != nil {
					return err
				}
				event.Raw = log

				select {
				case sink <- event:
				case err := <-sub.Err():
					return err
				case <-quit:
					return nil
				}
			case err := <-sub.Err():
				return err
			case <-quit:
				return nil
			}
		}
	}), nil
}

// ParsePeerStatusUpdated is a log parse operation binding the contract event 0x72a76c75c9365c7b93ba1f1c87ea32f7fe3a11b1d613741a801205de7e99f84c.
//
// Solidity: event PeerStatusUpdated(address indexed peer, bool active, uint64 lastSeen)
func (_Peerregistry *PeerregistryFilterer) ParsePeerStatusUpdated(log types.Log) (*PeerregistryPeerStatusUpdated, error) {
	event := new(PeerregistryPeerStatusUpdated)
	if err := _Peerregistry.contract.UnpackLog(event, "PeerStatusUpdated", log); err != nil {
		return nil, err
	}
	event.Raw = log
	return event, nil
}

// PeerregistryRoundCreatedIterator is returned from FilterRoundCreated and is used to iterate over the raw logs and unpacked data for RoundCreated events raised by the Peerregistry contract.
type PeerregistryRoundCreatedIterator struct {
	Event *PeerregistryRoundCreated // Event containing the contract specifics and raw log

	contract *bind.BoundContract // Generic contract to use for unpacking event data
	event    string              // Event name to use for unpacking event data

	logs chan types.Log        // Log channel receiving the found contract events
	sub  ethereum.Subscription // Subscription for errors, completion and termination
	done bool                  // Whether the subscription completed delivering logs
	fail error                 // Occurred error to stop iteration
}

// Next advances the iterator to the subsequent event, returning whether there
// are any more events found. In case of a retrieval or parsing error, false is
// returned and Error() can be queried for the exact failure.
func (it *PeerregistryRoundCreatedIterator) Next() bool {
	// If the iterator failed, stop iterating
	if it.fail != nil {
		return false
	}
	// If the iterator completed, deliver directly whatever's available
	if it.done {
		select {
		case log := <-it.logs:
			it.Event = new(PeerregistryRoundCreated)
			if err := it.contract.UnpackLog(it.Event, it.event, log); err != nil {
				it.fail = err
				return false
			}
			it.Event.Raw = log
			return true

		default:
			return false
		}
	}
	// Iterator still in progress, wait for either a data or an error event
	select {
	case log := <-it.logs:
		it.Event = new(PeerregistryRoundCreated)
		if err := it.contract.UnpackLog(it.Event, it.event, log); err != nil {
			it.fail = err
			return false
		}
		it.Event.Raw = log
		return true

	case err := <-it.sub.Err():
		it.done = true
		it.fail = err
		return it.Next()
	}
}

// Error returns any retrieval or parsing error occurred during filtering.
func (it *PeerregistryRoundCreatedIterator) Error() error {
	return it.fail
}

// Close terminates the iteration process, releasing any pending underlying
// resources.
func (it *PeerregistryRoundCreatedIterator) Close() error {
	it.sub.Unsubscribe()
	return nil
}

// PeerregistryRoundCreated represents a RoundCreated event raised by the Peerregistry contract.
type PeerregistryRoundCreated struct {
	RoundId      *big.Int
	Creator      common.Address
	Participants []common.Address
	Raw          types.Log // Blockchain specific contextual infos
}

// FilterRoundCreated is a free log retrieval operation binding the contract event 0x30e9a307c2e2af7ce36c24cfc7bdbf5c6f065938b9e2a317303fcf15f128783f.
//
// Solidity: event RoundCreated(uint256 indexed roundId, address indexed creator, address[] participants)
func (_Peerregistry *PeerregistryFilterer) FilterRoundCreated(opts *bind.FilterOpts, roundId []*big.Int, creator []common.Address) (*PeerregistryRoundCreatedIterator, error) {

	var roundIdRule []interface{}
	for _, roundIdItem := range roundId {
		roundIdRule = append(roundIdRule, roundIdItem)
	}
	var creatorRule []interface{}
	for _, creatorItem := range creator {
		creatorRule = append(creatorRule, creatorItem)
	}

	logs, sub, err := _Peerregistry.contract.FilterLogs(opts, "RoundCreated", roundIdRule, creatorRule)
	if err != nil {
		return nil, err
	}
	return &PeerregistryRoundCreatedIterator{contract: _Peerregistry.contract, event: "RoundCreated", logs: logs, sub: sub}, nil
}

// WatchRoundCreated is a free log subscription operation binding the contract event 0x30e9a307c2e2af7ce36c24cfc7bdbf5c6f065938b9e2a317303fcf15f128783f.
//
// Solidity: event RoundCreated(uint256 indexed roundId, address indexed creator, address[] participants)
func (_Peerregistry *PeerregistryFilterer) WatchRoundCreated(opts *bind.WatchOpts, sink chan<- *PeerregistryRoundCreated, roundId []*big.Int, creator []common.Address) (event.Subscription, error) {

	var roundIdRule []interface{}
	for _, roundIdItem := range roundId {
		roundIdRule = append(roundIdRule, roundIdItem)
	}
	var creatorRule []interface{}
	for _, creatorItem := range creator {
		creatorRule = append(creatorRule, creatorItem)
	}

	logs, sub, err := _Peerregistry.contract.WatchLogs(opts, "RoundCreated", roundIdRule, creatorRule)
	if err != nil {
		return nil, err
	}
	return event.NewSubscription(func(quit <-chan struct{}) error {
		defer sub.Unsubscribe()
		for {
			select {
			case log := <-logs:
				// New log arrived, parse the event and forward to the user
				event := new(PeerregistryRoundCreated)
				if err := _Peerregistry.contract.UnpackLog(event, "RoundCreated", log); err != nil {
					return err
				}
				event.Raw = log

				select {
				case sink <- event:
				case err := <-sub.Err():
					return err
				case <-quit:
					return nil
				}
			case err := <-sub.Err():
				return err
			case <-quit:
				return nil
			}
		}
	}), nil
}

// ParseRoundCreated is a log parse operation binding the contract event 0x30e9a307c2e2af7ce36c24cfc7bdbf5c6f065938b9e2a317303fcf15f128783f.
//
// Solidity: event RoundCreated(uint256 indexed roundId, address indexed creator, address[] participants)
func (_Peerregistry *PeerregistryFilterer) ParseRoundCreated(log types.Log) (*PeerregistryRoundCreated, error) {
	event := new(PeerregistryRoundCreated)
	if err := _Peerregistry.contract.UnpackLog(event, "RoundCreated", log); err != nil {
		return nil, err
	}
	event.Raw = log
	return event, nil
}

// PeerregistryRoundResultSubmittedIterator is returned from FilterRoundResultSubmitted and is used to iterate over the raw logs and unpacked data for RoundResultSubmitted events raised by the Peerregistry contract.
type PeerregistryRoundResultSubmittedIterator struct {
	Event *PeerregistryRoundResultSubmitted // Event containing the contract specifics and raw log

	contract *bind.BoundContract // Generic contract to use for unpacking event data
	event    string              // Event name to use for unpacking event data

	logs chan types.Log        // Log channel receiving the found contract events
	sub  ethereum.Subscription // Subscription for errors, completion and termination
	done bool                  // Whether the subscription completed delivering logs
	fail error                 // Occurred error to stop iteration
}

// Next advances the iterator to the subsequent event, returning whether there
// are any more events found. In case of a retrieval or parsing error, false is
// returned and Error() can be queried for the exact failure.
func (it *PeerregistryRoundResultSubmittedIterator) Next() bool {
	// If the iterator failed, stop iterating
	if it.fail != nil {
		return false
	}
	// If the iterator completed, deliver directly whatever's available
	if it.done {
		select {
		case log := <-it.logs:
			it.Event = new(PeerregistryRoundResultSubmitted)
			if err := it.contract.UnpackLog(it.Event, it.event, log); err != nil {
				it.fail = err
				return false
			}
			it.Event.Raw = log
			return true

		default:
			return false
		}
	}
	// Iterator still in progress, wait for either a data or an error event
	select {
	case log := <-it.logs:
		it.Event = new(PeerregistryRoundResultSubmitted)
		if err := it.contract.UnpackLog(it.Event, it.event, log); err != nil {
			it.fail = err
			return false
		}
		it.Event.Raw = log
		return true

	case err := <-it.sub.Err():
		it.done = true
		it.fail = err
		return it.Next()
	}
}

// Error returns any retrieval or parsing error occurred during filtering.
func (it *PeerregistryRoundResultSubmittedIterator) Error() error {
	return it.fail
}

// Close terminates the iteration process, releasing any pending underlying
// resources.
func (it *PeerregistryRoundResultSubmittedIterator) Close() error {
	it.sub.Unsubscribe()
	return nil
}

// PeerregistryRoundResultSubmitted represents a RoundResultSubmitted event raised by the Peerregistry contract.
type PeerregistryRoundResultSubmitted struct {
	RoundId   *big.Int
	Submitter common.Address
	Result    [32]byte
	Raw       types.Log // Blockchain specific contextual infos
}

// FilterRoundResultSubmitted is a free log retrieval operation binding the contract event 0x8068f9cefb3e2f972927524af4f8961ae06c15e2e6993be2c74ff1ac3968af68.
//
// Solidity: event RoundResultSubmitted(uint256 indexed roundId, address indexed submitter, bytes32 result)
func (_Peerregistry *PeerregistryFilterer) FilterRoundResultSubmitted(opts *bind.FilterOpts, roundId []*big.Int, submitter []common.Address) (*PeerregistryRoundResultSubmittedIterator, error) {

	var roundIdRule []interface{}
	for _, roundIdItem := range roundId {
		roundIdRule = append(roundIdRule, roundIdItem)
	}
	var submitterRule []interface{}
	for _, submitterItem := range submitter {
		submitterRule = append(submitterRule, submitterItem)
	}

	logs, sub, err := _Peerregistry.contract.FilterLogs(opts, "RoundResultSubmitted", roundIdRule, submitterRule)
	if err != nil {
		return nil, err
	}
	return &PeerregistryRoundResultSubmittedIterator{contract: _Peerregistry.contract, event: "RoundResultSubmitted", logs: logs, sub: sub}, nil
}

// WatchRoundResultSubmitted is a free log subscription operation binding the contract event 0x8068f9cefb3e2f972927524af4f8961ae06c15e2e6993be2c74ff1ac3968af68.
//
// Solidity: event RoundResultSubmitted(uint256 indexed roundId, address indexed submitter, bytes32 result)
func (_Peerregistry *PeerregistryFilterer) WatchRoundResultSubmitted(opts *bind.WatchOpts, sink chan<- *PeerregistryRoundResultSubmitted, roundId []*big.Int, submitter []common.Address) (event.Subscription, error) {

	var roundIdRule []interface{}
	for _, roundIdItem := range roundId {
		roundIdRule = append(roundIdRule, roundIdItem)
	}
	var submitterRule []interface{}
	for _, submitterItem := range submitter {
		submitterRule = append(submitterRule, submitterItem)
	}

	logs, sub, err := _Peerregistry.contract.WatchLogs(opts, "RoundResultSubmitted", roundIdRule, submitterRule)
	if err != nil {
		return nil, err
	}
	return event.NewSubscription(func(quit <-chan struct{}) error {
		defer sub.Unsubscribe()
		for {
			select {
			case log := <-logs:
				// New log arrived, parse the event and forward to the user
				event := new(PeerregistryRoundResultSubmitted)
				if err := _Peerregistry.contract.UnpackLog(event, "RoundResultSubmitted", log); err != nil {
					return err
				}
				event.Raw = log

				select {
				case sink <- event:
				case err := <-sub.Err():
					return err
				case <-quit:
					return nil
				}
			case err := <-sub.Err():
				return err
			case <-quit:
				return nil
			}
		}
	}), nil
}

// ParseRoundResultSubmitted is a log parse operation binding the contract event 0x8068f9cefb3e2f972927524af4f8961ae06c15e2e6993be2c74ff1ac3968af68.
//
// Solidity: event RoundResultSubmitted(uint256 indexed roundId, address indexed submitter, bytes32 result)
func (_Peerregistry *PeerregistryFilterer) ParseRoundResultSubmitted(log types.Log) (*PeerregistryRoundResultSubmitted, error) {
	event := new(PeerregistryRoundResultSubmitted)
	if err := _Peerregistry.contract.UnpackLog(event, "RoundResultSubmitted", log); err != nil {
		return nil, err
	}
	event.Raw = log
	return event, nil
}
