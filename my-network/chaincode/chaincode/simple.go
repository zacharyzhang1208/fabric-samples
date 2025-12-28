package chaincode

import (
	"fmt"

	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
)

// SimpleContract is a simple key-value store chaincode
type SimpleContract struct {
	contractapi.Contract
}

// Set stores a key-value pair
func (s *SimpleContract) Set(ctx contractapi.TransactionContextInterface, key string, value string) error {
	return ctx.GetStub().PutState(key, []byte(value))
}

// Get retrieves the value for a given key
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
