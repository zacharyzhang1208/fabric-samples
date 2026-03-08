package contract

import (
	"fmt"

	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
)

const (
	// Training Channel PDC collections
	CollectionVPSAOrg1Shards = "vpsaOrg1Shards"
	CollectionVPSAOrg2Shards = "vpsaOrg2Shards"

	// Inference Channel PDC collections
	CollectionInferenceTPShards   = "inferenceTPShards"
	CollectionInferenceOrg1Shards = "inferenceOrg1Shards"
	CollectionInferenceOrg2Shards = "inferenceOrg2Shards"
)

// SimpleContract is a simple key-value store chaincode
type SimpleContract struct {
	contractapi.Contract
}

// Set stores a key-value pair in public world state.
func (s *SimpleContract) Set(ctx contractapi.TransactionContextInterface, key string, value string) error {
	return ctx.GetStub().PutState(key, []byte(value))
}

// Get retrieves the value for a given key from public world state.
func (s *SimpleContract) Get(ctx contractapi.TransactionContextInterface, key string) (string, error) {
	valueBytes, err := ctx.GetStub().GetState(key)
	if err != nil {
		return "", fmt.Errorf("failed to read from world state: %v", err)
	}
	if valueBytes == nil {
		return "", fmt.Errorf("the key %s does not exist", key)
	}
	return string(valueBytes), nil
}

// SetPrivateShard stores a shard in a specified private collection.
func (s *SimpleContract) SetPrivateShard(ctx contractapi.TransactionContextInterface, collection string, key string, value string) error {
	validCollections := map[string]bool{
		CollectionVPSAOrg1Shards:      true,
		CollectionVPSAOrg2Shards:      true,
		CollectionInferenceTPShards:   true,
		CollectionInferenceOrg1Shards: true,
		CollectionInferenceOrg2Shards: true,
	}

	if !validCollections[collection] {
		return fmt.Errorf("unsupported collection: %s", collection)
	}
	return ctx.GetStub().PutPrivateData(collection, key, []byte(value))
}

// GetPrivateShard retrieves a shard from a specified private collection.
func (s *SimpleContract) GetPrivateShard(ctx contractapi.TransactionContextInterface, collection string, key string) (string, error) {
	validCollections := map[string]bool{
		CollectionVPSAOrg1Shards:      true,
		CollectionVPSAOrg2Shards:      true,
		CollectionInferenceTPShards:   true,
		CollectionInferenceOrg1Shards: true,
		CollectionInferenceOrg2Shards: true,
	}

	if !validCollections[collection] {
		return "", fmt.Errorf("unsupported collection: %s", collection)
	}

	valueBytes, err := ctx.GetStub().GetPrivateData(collection, key)
	if err != nil {
		return "", fmt.Errorf("failed to read private data from %s: %v", collection, err)
	}
	if valueBytes == nil {
		return "", fmt.Errorf("the key %s does not exist in collection %s", key, collection)
	}
	return string(valueBytes), nil
}
