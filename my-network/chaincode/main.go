package main

import (
	"log"

	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
	"github.com/hyperledger/fabric-samples/my-network/chaincode/contract"
)

func main() {
	// Register all contracts
	chaincode, err := contractapi.NewChaincode(
		&contract.SimpleContract{},      // Basic key-value and PDC operations
		&contract.AggregationContract{}, // Federated learning aggregation (Training Channel)
		&contract.InferenceContract{},   // Secure inference (Inference Channel)
	)
	if err != nil {
		log.Panicf("Error creating chaincode: %v", err)
	}

	if err := chaincode.Start(); err != nil {
		log.Panicf("Error starting chaincode: %v", err)
	}
}
