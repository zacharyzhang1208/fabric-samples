package main

import (
	"log"

	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
	"github.com/hyperledger/fabric-samples/my-network/chaincode/chaincode"
)

func main() {
	simpleChaincode, err := contractapi.NewChaincode(&chaincode.SimpleContract{})
	if err != nil {
		log.Panicf("Error creating simple chaincode: %v", err)
	}

	if err := simpleChaincode.Start(); err != nil {
		log.Panicf("Error starting simple chaincode: %v", err)
	}
}
