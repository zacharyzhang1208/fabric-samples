package contract

import (
	"encoding/json"
	"fmt"

	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
)

// InferenceContract handles secure inference on Inference Channel
type InferenceContract struct {
	contractapi.Contract
}

// InferenceRequest represents a query from third-party (TP)
type InferenceRequest struct {
	RequestID string `json:"requestId"` // Unique request identifier
	QueryData string `json:"queryData"` // Encrypted query data
	Timestamp int64  `json:"timestamp"` // Unix timestamp
	Status    string `json:"status"`    // pending, processing, completed
}

// InferenceResult represents the aggregated inference result
type InferenceResult struct {
	RequestID    string   `json:"requestId"`    // Reference to original request
	ResultData   string   `json:"resultData"`   // Final inference result
	Contributors []string `json:"contributors"` // Organizations that contributed
	Timestamp    int64    `json:"timestamp"`    // Unix timestamp
}

// PartialResult represents a partial inference result from one organization
type PartialResult struct {
	RequestID string `json:"requestId"` // Reference to request
	OrgID     string `json:"orgId"`     // Organization ID
	Shard     string `json:"shard"`     // Partial computation result
	Timestamp int64  `json:"timestamp"` // Unix timestamp
}

// SubmitInferenceRequest allows TP to submit an encrypted inference query
// The query is stored in TP's private collection (inferenceTPShards)
func (i *InferenceContract) SubmitInferenceRequest(ctx contractapi.TransactionContextInterface,
	requestID string, queryData string) error {

	// Verify caller is TP
	clientMSPID, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return fmt.Errorf("failed to get client MSP ID: %v", err)
	}
	if clientMSPID != "TPMSP" {
		return fmt.Errorf("only TP can submit inference requests")
	}

	// Create inference request
	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return fmt.Errorf("failed to get timestamp: %v", err)
	}

	request := InferenceRequest{
		RequestID: requestID,
		QueryData: queryData,
		Timestamp: txTimestamp.Seconds,
		Status:    "pending",
	}

	requestJSON, err := json.Marshal(request)
	if err != nil {
		return fmt.Errorf("failed to marshal request: %v", err)
	}

	// Store in TP's private collection
	err = ctx.GetStub().PutPrivateData(CollectionInferenceTPShards, requestID, requestJSON)
	if err != nil {
		return fmt.Errorf("failed to store request in PDC: %v", err)
	}

	// Also create a public record (without sensitive query data)
	publicRequest := map[string]interface{}{
		"requestId": requestID,
		"timestamp": request.Timestamp,
		"status":    "pending",
	}
	publicJSON, _ := json.Marshal(publicRequest)
	err = ctx.GetStub().PutState(fmt.Sprintf("request_%s", requestID), publicJSON)
	if err != nil {
		return fmt.Errorf("failed to store public request record: %v", err)
	}

	return nil
}

// SubmitPartialResult allows Org1/Org2 to submit their partial inference result
// Each organization computes on their feature partition and stores result in their PDC
func (i *InferenceContract) SubmitPartialResult(ctx contractapi.TransactionContextInterface,
	collection string, requestID string, shardData string) error {

	// Get caller's organization ID
	clientMSPID, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return fmt.Errorf("failed to get client MSP ID: %v", err)
	}

	// Validate collection matches caller's organization
	validCollections := map[string]string{
		"Org1MSP": CollectionInferenceOrg1Shards,
		"Org2MSP": CollectionInferenceOrg2Shards,
	}

	expectedCollection, ok := validCollections[clientMSPID]
	if !ok || collection != expectedCollection {
		return fmt.Errorf("invalid collection for organization %s", clientMSPID)
	}

	// Create partial result
	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return fmt.Errorf("failed to get timestamp: %v", err)
	}

	partial := PartialResult{
		RequestID: requestID,
		OrgID:     clientMSPID,
		Shard:     shardData,
		Timestamp: txTimestamp.Seconds,
	}

	partialJSON, err := json.Marshal(partial)
	if err != nil {
		return fmt.Errorf("failed to marshal partial result: %v", err)
	}

	// Store in organization's private collection
	key := fmt.Sprintf("partial_%s_%s", requestID, clientMSPID)
	err = ctx.GetStub().PutPrivateData(collection, key, partialJSON)
	if err != nil {
		return fmt.Errorf("failed to store partial result in PDC: %v", err)
	}

	return nil
}

// AggregateInferenceResults aggregates partial results from all participants
// and creates the final inference result accessible to TP
func (i *InferenceContract) AggregateInferenceResults(ctx contractapi.TransactionContextInterface,
	requestID string, contributors []string) error {

	// TODO: Implement aggregation logic
	// For secure inference:
	// 1. Read partial results from each organization's PDC (requires proper access)
	// 2. Combine partial predictions (e.g., vertical model ensemble)
	// 3. Apply secure aggregation/decryption
	// 4. Store final result accessible to TP

	// Placeholder: create aggregated result
	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return fmt.Errorf("failed to get timestamp: %v", err)
	}

	result := InferenceResult{
		RequestID:    requestID,
		ResultData:   "aggregated_inference_result_placeholder",
		Contributors: contributors,
		Timestamp:    txTimestamp.Seconds,
	}

	resultJSON, err := json.Marshal(result)
	if err != nil {
		return fmt.Errorf("failed to marshal result: %v", err)
	}

	// Store on public ledger (accessible to all including TP)
	key := fmt.Sprintf("result_%s", requestID)
	err = ctx.GetStub().PutState(key, resultJSON)
	if err != nil {
		return fmt.Errorf("failed to store inference result: %v", err)
	}

	// Update request status
	updateStatus := map[string]interface{}{
		"requestId": requestID,
		"timestamp": txTimestamp.Seconds,
		"status":    "completed",
	}
	statusJSON, _ := json.Marshal(updateStatus)
	ctx.GetStub().PutState(fmt.Sprintf("request_%s", requestID), statusJSON)

	return nil
}

// GetInferenceResult allows TP to retrieve the final inference result
func (i *InferenceContract) GetInferenceResult(ctx contractapi.TransactionContextInterface,
	requestID string) (*InferenceResult, error) {

	key := fmt.Sprintf("result_%s", requestID)
	resultJSON, err := ctx.GetStub().GetState(key)
	if err != nil {
		return nil, fmt.Errorf("failed to read inference result: %v", err)
	}
	if resultJSON == nil {
		return nil, fmt.Errorf("inference result not found for request %s", requestID)
	}

	var result InferenceResult
	err = json.Unmarshal(resultJSON, &result)
	if err != nil {
		return nil, fmt.Errorf("failed to unmarshal result: %v", err)
	}

	return &result, nil
}

// GetRequestStatus allows any participant to check the status of an inference request
func (i *InferenceContract) GetRequestStatus(ctx contractapi.TransactionContextInterface,
	requestID string) (string, error) {

	key := fmt.Sprintf("request_%s", requestID)
	statusJSON, err := ctx.GetStub().GetState(key)
	if err != nil {
		return "", fmt.Errorf("failed to read request status: %v", err)
	}
	if statusJSON == nil {
		return "not_found", nil
	}

	var status map[string]interface{}
	err = json.Unmarshal(statusJSON, &status)
	if err != nil {
		return "", fmt.Errorf("failed to unmarshal status: %v", err)
	}

	return status["status"].(string), nil
}

// GetPartialResult retrieves a partial result from an organization's PDC
// Only the owning organization can access their own partial result
func (i *InferenceContract) GetPartialResult(ctx contractapi.TransactionContextInterface,
	collection string, requestID string, orgID string) (*PartialResult, error) {

	key := fmt.Sprintf("partial_%s_%s", requestID, orgID)
	partialJSON, err := ctx.GetStub().GetPrivateData(collection, key)
	if err != nil {
		return nil, fmt.Errorf("failed to read from PDC: %v", err)
	}
	if partialJSON == nil {
		return nil, fmt.Errorf("partial result not found for request %s, org %s", requestID, orgID)
	}

	var partial PartialResult
	err = json.Unmarshal(partialJSON, &partial)
	if err != nil {
		return nil, fmt.Errorf("failed to unmarshal partial result: %v", err)
	}

	return &partial, nil
}
