package contract

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
)

// AggregationContract handles federated learning aggregation on Training Channel
// Supports both synchronous and asynchronous FL modes
type AggregationContract struct {
	contractapi.Contract
}

// ModelUpdate represents a local model update from a participant
type ModelUpdate struct {
	OrgID           string `json:"orgId"`           // Organization identifier
	Round           int    `json:"round"`           // Training round number (for sync mode)
	Version         int    `json:"version"`         // Model version (for async mode)
	UpdateData      string `json:"updateData"`      // Serialized model update (gradients/weights)
	SampleCount     int    `json:"sampleCount"`     // Number of local samples used
	BaselineVersion int    `json:"baselineVersion"` // Global model version used as baseline for this update (for async staleness tracking)
	Timestamp       int64  `json:"timestamp"`       // Unix timestamp
}

// GlobalModel represents the aggregated global model
type GlobalModel struct {
	Round        int      `json:"round"`        // Training round number (sync mode)
	Version      int      `json:"version"`      // Model version (async mode)
	ModelData    string   `json:"modelData"`    // Serialized global model
	TotalSamples int      `json:"totalSamples"` // Samples used to build this model
	Participants []string `json:"participants"` // List of participating organizations
	Timestamp    int64    `json:"timestamp"`    // Unix timestamp
}

// RoundStatus tracks synchronous FL round progress
type RoundStatus struct {
	Round           int      `json:"round"`           // Current round number
	ExpectedCount   int      `json:"expectedCount"`   // Expected number of participants
	SubmittedOrgs   []string `json:"submittedOrgs"`   // Organizations that submitted
	AggregationDone bool     `json:"aggregationDone"` // Whether aggregation is completed
	Timestamp       int64    `json:"timestamp"`       // Unix timestamp
}

// OrgRoundStatus tracks intra-organization progress for hierarchical FL.
type OrgRoundStatus struct {
	Round            int      `json:"round"`
	OrgID            string   `json:"orgId"`
	ExpectedNodes    int      `json:"expectedNodes"`
	SubmittedNodeIDs []string `json:"submittedNodeIds"`
	AggregationDone  bool     `json:"aggregationDone"`
	Timestamp        int64    `json:"timestamp"`
}

// ============================================================================
// LEGACY METHODS (for backward compatibility)
// ============================================================================

// SubmitLocalUpdate allows an organization to submit their local model update to PDC
// DEPRECATED: Use SubmitLocalUpdateSync or SubmitLocalUpdateAsync
// The update is stored in the organization's private shard (vpsaOrg1Shards or vpsaOrg2Shards)
func (a *AggregationContract) SubmitLocalUpdate(ctx contractapi.TransactionContextInterface,
	collection string, round int, updateData string, sampleCount int) error {

	// Get caller's organization ID
	clientMSPID, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return fmt.Errorf("failed to get client MSP ID: %v", err)
	}

	// Validate collection matches caller's organization
	validCollections := map[string]string{
		"Org1MSP": CollectionVPSAOrg1Shards,
		"Org2MSP": CollectionVPSAOrg2Shards,
	}

	expectedCollection, ok := validCollections[clientMSPID]
	if !ok || collection != expectedCollection {
		return fmt.Errorf("invalid collection for organization %s", clientMSPID)
	}

	// Create model update
	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return fmt.Errorf("failed to get timestamp: %v", err)
	}

	update := ModelUpdate{
		OrgID:       clientMSPID,
		Round:       round,
		UpdateData:  updateData,
		SampleCount: sampleCount,
		Timestamp:   txTimestamp.Seconds,
	}

	updateJSON, err := json.Marshal(update)
	if err != nil {
		return fmt.Errorf("failed to marshal update: %v", err)
	}

	// Store in private data collection
	key := fmt.Sprintf("update_round_%d_%s", round, clientMSPID)
	err = ctx.GetStub().PutPrivateData(collection, key, updateJSON)
	if err != nil {
		return fmt.Errorf("failed to store update in PDC: %v", err)
	}

	// Store an aggregation-safe public record for runnable FedAvg demo.
	publicKey := fmt.Sprintf("update_public_round_%d_%s", round, clientMSPID)
	err = ctx.GetStub().PutState(publicKey, updateJSON)
	if err != nil {
		return fmt.Errorf("failed to store public update record: %v", err)
	}

	return nil
}

// GetLocalUpdate retrieves a local update from PDC (only accessible by the owning organization)
func (a *AggregationContract) GetLocalUpdate(ctx contractapi.TransactionContextInterface,
	collection string, round int, orgID string) (*ModelUpdate, error) {

	key := fmt.Sprintf("update_round_%d_%s", round, orgID)
	updateJSON, err := ctx.GetStub().GetPrivateData(collection, key)
	if err != nil {
		return nil, fmt.Errorf("failed to read from PDC: %v", err)
	}
	if updateJSON == nil {
		return nil, fmt.Errorf("update not found for round %d, org %s", round, orgID)
	}

	var update ModelUpdate
	err = json.Unmarshal(updateJSON, &update)
	if err != nil {
		return nil, fmt.Errorf("failed to unmarshal update: %v", err)
	}

	return &update, nil
}

// AggregateUpdates performs secure aggregation of local updates and publishes global model
// This should be called after all participants submit their updates
// Implementation depends on your aggregation strategy (FedAvg, VPSA, etc.)
func (a *AggregationContract) AggregateUpdates(ctx contractapi.TransactionContextInterface,
	round int, participants []string) error {
	return a.aggregateSync(ctx, round, participants)
}

// GetGlobalModel retrieves the global model for a specific round
func (a *AggregationContract) GetGlobalModel(ctx contractapi.TransactionContextInterface,
	round int) (*GlobalModel, error) {

	key := fmt.Sprintf("global_model_round_%d", round)
	modelJSON, err := ctx.GetStub().GetState(key)
	if err != nil {
		return nil, fmt.Errorf("failed to read global model: %v", err)
	}
	if modelJSON == nil {
		return nil, fmt.Errorf("global model not found for round %d", round)
	}

	var model GlobalModel
	err = json.Unmarshal(modelJSON, &model)
	if err != nil {
		return nil, fmt.Errorf("failed to unmarshal global model: %v", err)
	}

	return &model, nil
}

// GetCurrentRound returns the current training round number
func (a *AggregationContract) GetCurrentRound(ctx contractapi.TransactionContextInterface) (int, error) {
	roundJSON, err := ctx.GetStub().GetState("current_round")
	if err != nil {
		return 0, fmt.Errorf("failed to read current round: %v", err)
	}
	if roundJSON == nil {
		return 0, nil // Round 0 if not initialized
	}

	var round int
	err = json.Unmarshal(roundJSON, &round)
	if err != nil {
		return 0, fmt.Errorf("failed to unmarshal round: %v", err)
	}

	return round, nil
}

// IncrementRound advances to the next training round
func (a *AggregationContract) IncrementRound(ctx contractapi.TransactionContextInterface) error {
	currentRound, err := a.GetCurrentRound(ctx)
	if err != nil {
		return err
	}

	nextRound := currentRound + 1
	roundJSON, err := json.Marshal(nextRound)
	if err != nil {
		return fmt.Errorf("failed to marshal round: %v", err)
	}

	return ctx.GetStub().PutState("current_round", roundJSON)
}

// ============================================================================
// SYNCHRONOUS FL METHODS
// ============================================================================

// InitSyncRound initializes a new synchronous FL round
func (a *AggregationContract) InitSyncRound(ctx contractapi.TransactionContextInterface,
	round int, expectedParticipants int) error {

	// Check if round already exists
	existing, _ := a.GetRoundStatus(ctx, round)
	if existing != nil {
		if existing.ExpectedCount == expectedParticipants {
			// Idempotent init: same round config is treated as success.
			return nil
		}
		return fmt.Errorf(
			"round %d already initialized with expectedParticipants=%d",
			round,
			existing.ExpectedCount,
		)
	}

	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return fmt.Errorf("failed to get timestamp: %v", err)
	}

	status := RoundStatus{
		Round:           round,
		ExpectedCount:   expectedParticipants,
		SubmittedOrgs:   []string{},
		AggregationDone: false,
		Timestamp:       txTimestamp.Seconds,
	}

	statusJSON, err := json.Marshal(status)
	if err != nil {
		return fmt.Errorf("failed to marshal round status: %v", err)
	}

	key := fmt.Sprintf("round_status_%d", round)
	return ctx.GetStub().PutState(key, statusJSON)
}

// InitHierarchicalRound initializes a round for two-layer sync FL.
// Layer-1: node updates -> org aggregation. Layer-2: org aggregation -> global aggregation.
func (a *AggregationContract) InitHierarchicalRound(ctx contractapi.TransactionContextInterface,
	round int, expectedOrgs int, org1ExpectedNodes int, org2ExpectedNodes int) error {

	if org1ExpectedNodes <= 0 || org2ExpectedNodes <= 0 {
		return fmt.Errorf("expected node counts must be > 0")
	}

	if err := a.InitSyncRound(ctx, round, expectedOrgs); err != nil {
		return err
	}

	if err := a.initOrgRoundStatus(ctx, round, "Org1MSP", org1ExpectedNodes); err != nil {
		return err
	}
	if err := a.initOrgRoundStatus(ctx, round, "Org2MSP", org2ExpectedNodes); err != nil {
		return err
	}

	return nil
}

func (a *AggregationContract) initOrgRoundStatus(
	ctx contractapi.TransactionContextInterface,
	round int,
	orgID string,
	expectedNodes int,
) error {
	key := fmt.Sprintf("org_round_status_%d_%s", round, orgID)
	existingJSON, err := ctx.GetStub().GetState(key)
	if err != nil {
		return fmt.Errorf("failed to read org round status for %s: %v", orgID, err)
	}

	if existingJSON != nil {
		var existing OrgRoundStatus
		if err := json.Unmarshal(existingJSON, &existing); err != nil {
			return fmt.Errorf("failed to unmarshal org round status for %s: %v", orgID, err)
		}
		if existing.ExpectedNodes == expectedNodes {
			return nil
		}
		return fmt.Errorf(
			"round %d org %s already initialized with expectedNodes=%d",
			round,
			orgID,
			existing.ExpectedNodes,
		)
	}

	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return fmt.Errorf("failed to get timestamp: %v", err)
	}

	status := OrgRoundStatus{
		Round:            round,
		OrgID:            orgID,
		ExpectedNodes:    expectedNodes,
		SubmittedNodeIDs: []string{},
		AggregationDone:  false,
		Timestamp:        txTimestamp.Seconds,
	}

	statusJSON, err := json.Marshal(status)
	if err != nil {
		return fmt.Errorf("failed to marshal org round status: %v", err)
	}

	return ctx.GetStub().PutState(key, statusJSON)
}

// SubmitLocalNodeUpdateSync records one node's local update in layer-1 (intra-org).
func (a *AggregationContract) SubmitLocalNodeUpdateSync(ctx contractapi.TransactionContextInterface,
	collection string, round int, nodeID string, updateData string, sampleCount int) error {

	if strings.TrimSpace(nodeID) == "" {
		return fmt.Errorf("nodeID must not be empty")
	}

	clientMSPID, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return fmt.Errorf("failed to get client MSP ID: %v", err)
	}

	validCollections := map[string]string{
		"Org1MSP": CollectionVPSAOrg1Shards,
		"Org2MSP": CollectionVPSAOrg2Shards,
	}

	expectedCollection, ok := validCollections[clientMSPID]
	if !ok || collection != expectedCollection {
		return fmt.Errorf("invalid collection for organization %s", clientMSPID)
	}

	roundStatus, err := a.GetRoundStatus(ctx, round)
	if err != nil {
		return fmt.Errorf("round %d not initialized: %v", round, err)
	}
	if roundStatus.AggregationDone {
		return fmt.Errorf("round %d already completed", round)
	}

	orgStatus, err := a.GetOrgRoundStatus(ctx, round, clientMSPID)
	if err != nil {
		return fmt.Errorf("org round %d not initialized for %s: %v", round, clientMSPID, err)
	}
	if orgStatus.AggregationDone {
		return fmt.Errorf("org round %d already completed for %s", round, clientMSPID)
	}

	for _, submitted := range orgStatus.SubmittedNodeIDs {
		if submitted == nodeID {
			return nil
		}
	}

	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return fmt.Errorf("failed to get timestamp: %v", err)
	}

	update := ModelUpdate{
		OrgID:       clientMSPID,
		Round:       round,
		Version:     0,
		UpdateData:  updateData,
		SampleCount: sampleCount,
		Timestamp:   txTimestamp.Seconds,
	}

	updateJSON, err := json.Marshal(update)
	if err != nil {
		return fmt.Errorf("failed to marshal update: %v", err)
	}

	privateKey := fmt.Sprintf("node_update_round_%d_%s_%s", round, clientMSPID, nodeID)
	if err := ctx.GetStub().PutPrivateData(collection, privateKey, updateJSON); err != nil {
		return pdcWriteError(collection, err)
	}

	publicKey := fmt.Sprintf("node_update_public_round_%d_%s_%s", round, clientMSPID, nodeID)
	if err := ctx.GetStub().PutState(publicKey, updateJSON); err != nil {
		return fmt.Errorf("failed to store public node update record: %v", err)
	}

	orgStatus.SubmittedNodeIDs = append(orgStatus.SubmittedNodeIDs, nodeID)
	orgStatusJSON, err := json.Marshal(orgStatus)
	if err != nil {
		return fmt.Errorf("failed to marshal org status: %v", err)
	}

	orgStatusKey := fmt.Sprintf("org_round_status_%d_%s", round, clientMSPID)
	return ctx.GetStub().PutState(orgStatusKey, orgStatusJSON)
}

// FinalizeOrgSyncRound performs layer-1 aggregation within caller's organization.
// It writes one org-level update that will be used by FinalizeSyncRound for layer-2 aggregation.
func (a *AggregationContract) FinalizeOrgSyncRound(ctx contractapi.TransactionContextInterface, round int) error {
	clientMSPID, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return fmt.Errorf("failed to get client MSP ID: %v", err)
	}

	orgStatus, err := a.GetOrgRoundStatus(ctx, round, clientMSPID)
	if err != nil {
		return fmt.Errorf("org round %d not initialized for %s: %v", round, clientMSPID, err)
	}

	if orgStatus.AggregationDone {
		return nil
	}

	if len(orgStatus.SubmittedNodeIDs) < orgStatus.ExpectedNodes {
		return fmt.Errorf(
			"org round %d not ready for %s: %d/%d submitted",
			round,
			clientMSPID,
			len(orgStatus.SubmittedNodeIDs),
			orgStatus.ExpectedNodes,
		)
	}

	var weightedSum []float64
	totalSamples := 0

	for _, nodeID := range orgStatus.SubmittedNodeIDs {
		publicKey := fmt.Sprintf("node_update_public_round_%d_%s_%s", round, clientMSPID, nodeID)
		updateJSON, err := ctx.GetStub().GetState(publicKey)
		if err != nil {
			return fmt.Errorf("failed to read node update for %s/%s: %v", clientMSPID, nodeID, err)
		}
		if updateJSON == nil {
			return fmt.Errorf("missing node update for round %d, %s/%s", round, clientMSPID, nodeID)
		}

		var update ModelUpdate
		if err := json.Unmarshal(updateJSON, &update); err != nil {
			return fmt.Errorf("failed to parse node update for %s/%s: %v", clientMSPID, nodeID, err)
		}
		if update.SampleCount <= 0 {
			return fmt.Errorf("invalid sample count from %s/%s: %d", clientMSPID, nodeID, update.SampleCount)
		}

		weights, err := parseWeights(update.UpdateData)
		if err != nil {
			return fmt.Errorf("invalid updateData from %s/%s: %v", clientMSPID, nodeID, err)
		}

		if weightedSum == nil {
			weightedSum = make([]float64, len(weights))
		}
		if len(weights) != len(weightedSum) {
			return fmt.Errorf("weight dimension mismatch for %s/%s", clientMSPID, nodeID)
		}

		for i := range weights {
			weightedSum[i] += weights[i] * float64(update.SampleCount)
		}
		totalSamples += update.SampleCount
	}

	if totalSamples <= 0 {
		return fmt.Errorf("totalSamples must be > 0 for %s", clientMSPID)
	}

	avgWeights := make([]float64, len(weightedSum))
	for i := range weightedSum {
		avgWeights[i] = weightedSum[i] / float64(totalSamples)
	}

	modelData, err := json.Marshal(avgWeights)
	if err != nil {
		return fmt.Errorf("failed to marshal org aggregated weights: %v", err)
	}

	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return fmt.Errorf("failed to get timestamp: %v", err)
	}

	orgUpdate := ModelUpdate{
		OrgID:       clientMSPID,
		Round:       round,
		Version:     0,
		UpdateData:  string(modelData),
		SampleCount: totalSamples,
		Timestamp:   txTimestamp.Seconds,
	}

	orgUpdateJSON, err := json.Marshal(orgUpdate)
	if err != nil {
		return fmt.Errorf("failed to marshal org update: %v", err)
	}

	validCollections := map[string]string{
		"Org1MSP": CollectionVPSAOrg1Shards,
		"Org2MSP": CollectionVPSAOrg2Shards,
	}
	orgCollection := validCollections[clientMSPID]

	privateOrgKey := fmt.Sprintf("update_round_%d_%s", round, clientMSPID)
	if err := ctx.GetStub().PutPrivateData(orgCollection, privateOrgKey, orgUpdateJSON); err != nil {
		return pdcWriteError(orgCollection, err)
	}

	publicOrgKey := fmt.Sprintf("update_public_round_%d_%s", round, clientMSPID)
	if err := ctx.GetStub().PutState(publicOrgKey, orgUpdateJSON); err != nil {
		return fmt.Errorf("failed to store org-level public update: %v", err)
	}

	orgStatus.AggregationDone = true
	orgStatusJSON, err := json.Marshal(orgStatus)
	if err != nil {
		return fmt.Errorf("failed to marshal org status: %v", err)
	}

	orgStatusKey := fmt.Sprintf("org_round_status_%d_%s", round, clientMSPID)
	if err := ctx.GetStub().PutState(orgStatusKey, orgStatusJSON); err != nil {
		return err
	}

	roundStatus, err := a.GetRoundStatus(ctx, round)
	if err != nil {
		return fmt.Errorf("round %d not initialized: %v", round, err)
	}

	if !containsString(roundStatus.SubmittedOrgs, clientMSPID) {
		roundStatus.SubmittedOrgs = append(roundStatus.SubmittedOrgs, clientMSPID)
		roundStatusJSON, err := json.Marshal(roundStatus)
		if err != nil {
			return fmt.Errorf("failed to marshal round status: %v", err)
		}
		roundStatusKey := fmt.Sprintf("round_status_%d", round)
		if err := ctx.GetStub().PutState(roundStatusKey, roundStatusJSON); err != nil {
			return err
		}
	}

	return nil
}

// GetOrgRoundStatus retrieves layer-1 status for one organization in one round.
func (a *AggregationContract) GetOrgRoundStatus(ctx contractapi.TransactionContextInterface,
	round int, orgID string) (*OrgRoundStatus, error) {

	key := fmt.Sprintf("org_round_status_%d_%s", round, orgID)
	statusJSON, err := ctx.GetStub().GetState(key)
	if err != nil {
		return nil, fmt.Errorf("failed to read org round status: %v", err)
	}
	if statusJSON == nil {
		return nil, fmt.Errorf("org round %d for %s not found", round, orgID)
	}

	var status OrgRoundStatus
	err = json.Unmarshal(statusJSON, &status)
	if err != nil {
		return nil, fmt.Errorf("failed to unmarshal org round status: %v", err)
	}

	return &status, nil
}

func containsString(arr []string, target string) bool {
	for _, v := range arr {
		if v == target {
			return true
		}
	}
	return false
}

// SubmitLocalUpdateSync submits local update in synchronous mode.
// It only records updates; aggregation is executed by FinalizeSyncRound.
func (a *AggregationContract) SubmitLocalUpdateSync(ctx contractapi.TransactionContextInterface,
	collection string, round int, updateData string, sampleCount int) error {

	// Get caller's organization ID
	clientMSPID, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return fmt.Errorf("failed to get client MSP ID: %v", err)
	}

	// Validate collection matches caller's organization
	validCollections := map[string]string{
		"Org1MSP": CollectionVPSAOrg1Shards,
		"Org2MSP": CollectionVPSAOrg2Shards,
	}

	expectedCollection, ok := validCollections[clientMSPID]
	if !ok || collection != expectedCollection {
		return fmt.Errorf("invalid collection for organization %s", clientMSPID)
	}

	// Get round status
	status, err := a.GetRoundStatus(ctx, round)
	if err != nil {
		return fmt.Errorf("round %d not initialized: %v", round, err)
	}

	if status.AggregationDone {
		return fmt.Errorf("round %d already completed", round)
	}

	// Check if organization already submitted
	for _, org := range status.SubmittedOrgs {
		if org == clientMSPID {
			// Idempotent submit: duplicate submit from the same org is treated as success.
			return nil
		}
	}

	// Create and store model update
	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return fmt.Errorf("failed to get timestamp: %v", err)
	}

	update := ModelUpdate{
		OrgID:       clientMSPID,
		Round:       round,
		Version:     0, // Not used in sync mode
		UpdateData:  updateData,
		SampleCount: sampleCount,
		Timestamp:   txTimestamp.Seconds,
	}

	updateJSON, err := json.Marshal(update)
	if err != nil {
		return fmt.Errorf("failed to marshal update: %v", err)
	}

	key := fmt.Sprintf("update_round_%d_%s", round, clientMSPID)
	err = ctx.GetStub().PutPrivateData(collection, key, updateJSON)
	if err != nil {
		return pdcWriteError(collection, err)
	}

	// Store an aggregation-safe public record for runnable FedAvg demo.
	publicKey := fmt.Sprintf("update_public_round_%d_%s", round, clientMSPID)
	err = ctx.GetStub().PutState(publicKey, updateJSON)
	if err != nil {
		return fmt.Errorf("failed to store public update record: %v", err)
	}

	// Update round status
	status.SubmittedOrgs = append(status.SubmittedOrgs, clientMSPID)

	// Save updated status
	statusJSON, err := json.Marshal(status)
	if err != nil {
		return fmt.Errorf("failed to marshal status: %v", err)
	}

	statusKey := fmt.Sprintf("round_status_%d", round)
	return ctx.GetStub().PutState(statusKey, statusJSON)
}

// FinalizeSyncRound performs aggregation for a synchronous round after all expected orgs submitted.
func (a *AggregationContract) FinalizeSyncRound(ctx contractapi.TransactionContextInterface, round int) error {
	status, err := a.GetRoundStatus(ctx, round)
	if err != nil {
		return fmt.Errorf("round %d not initialized: %v", round, err)
	}

	if status.AggregationDone {
		return nil
	}

	if len(status.SubmittedOrgs) < status.ExpectedCount {
		return fmt.Errorf(
			"round %d not ready: %d/%d submitted",
			round,
			len(status.SubmittedOrgs),
			status.ExpectedCount,
		)
	}

	if err := a.aggregateSync(ctx, round, status.SubmittedOrgs); err != nil {
		return fmt.Errorf("failed to aggregate round %d: %v", round, err)
	}

	status.AggregationDone = true
	statusJSON, err := json.Marshal(status)
	if err != nil {
		return fmt.Errorf("failed to marshal status: %v", err)
	}

	statusKey := fmt.Sprintf("round_status_%d", round)
	if err := ctx.GetStub().PutState(statusKey, statusJSON); err != nil {
		return err
	}

	// Update current_round to reflect completion of this round
	currentRound, err := a.GetCurrentRound(ctx)
	if err != nil {
		return fmt.Errorf("failed to get current round: %v", err)
	}

	// Only update if this round is the next expected round
	if round == currentRound+1 {
		if err := a.IncrementRound(ctx); err != nil {
			return fmt.Errorf("failed to increment round: %v", err)
		}
	}

	return nil
}

// GetRoundStatus retrieves the status of a synchronous FL round
func (a *AggregationContract) GetRoundStatus(ctx contractapi.TransactionContextInterface,
	round int) (*RoundStatus, error) {

	key := fmt.Sprintf("round_status_%d", round)
	statusJSON, err := ctx.GetStub().GetState(key)
	if err != nil {
		return nil, fmt.Errorf("failed to read round status: %v", err)
	}
	if statusJSON == nil {
		return nil, fmt.Errorf("round %d not found", round)
	}

	var status RoundStatus
	err = json.Unmarshal(statusJSON, &status)
	if err != nil {
		return nil, fmt.Errorf("failed to unmarshal status: %v", err)
	}

	return &status, nil
}

// aggregateSync performs synchronous aggregation
func (a *AggregationContract) aggregateSync(ctx contractapi.TransactionContextInterface,
	round int, participants []string) error {
	if len(participants) == 0 {
		return fmt.Errorf("no participants for round %d", round)
	}

	var weightedSum []float64
	totalSamples := 0

	for _, orgID := range participants {
		publicKey := fmt.Sprintf("update_public_round_%d_%s", round, orgID)
		updateJSON, err := ctx.GetStub().GetState(publicKey)
		if err != nil {
			return fmt.Errorf("failed to read update for %s: %v", orgID, err)
		}
		if updateJSON == nil {
			return fmt.Errorf("missing update for round %d, org %s", round, orgID)
		}

		var update ModelUpdate
		if err := json.Unmarshal(updateJSON, &update); err != nil {
			return fmt.Errorf("failed to parse update for %s: %v", orgID, err)
		}
		if update.SampleCount <= 0 {
			return fmt.Errorf("invalid sample count from %s: %d", orgID, update.SampleCount)
		}

		weights, err := parseWeights(update.UpdateData)
		if err != nil {
			return fmt.Errorf("invalid updateData from %s: %v", orgID, err)
		}

		if weightedSum == nil {
			weightedSum = make([]float64, len(weights))
		}
		if len(weights) != len(weightedSum) {
			return fmt.Errorf("weight dimension mismatch for %s", orgID)
		}

		for i := range weights {
			weightedSum[i] += weights[i] * float64(update.SampleCount)
		}
		totalSamples += update.SampleCount
	}

	if totalSamples <= 0 {
		return fmt.Errorf("totalSamples must be > 0")
	}

	avgWeights := make([]float64, len(weightedSum))
	for i := range weightedSum {
		avgWeights[i] = weightedSum[i] / float64(totalSamples)
	}

	modelData, err := json.Marshal(avgWeights)
	if err != nil {
		return fmt.Errorf("failed to marshal aggregated weights: %v", err)
	}

	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return fmt.Errorf("failed to get timestamp: %v", err)
	}

	globalModel := GlobalModel{
		Round:        round,
		Version:      0, // Not used in sync mode
		ModelData:    string(modelData),
		TotalSamples: totalSamples,
		Participants: participants,
		Timestamp:    txTimestamp.Seconds,
	}

	modelJSON, err := json.Marshal(globalModel)
	if err != nil {
		return fmt.Errorf("failed to marshal global model: %v", err)
	}

	key := fmt.Sprintf("global_model_round_%d", round)
	return ctx.GetStub().PutState(key, modelJSON)
}

// ============================================================================
// ASYNCHRONOUS FL METHODS
// ============================================================================

// SubmitLocalUpdateAsync submits local update in asynchronous mode with staleness tracking
// Immediately triggers aggregation without waiting for other participants
// baselineVersion indicates which global model version this update was based on (for staleness weighting)
func (a *AggregationContract) SubmitLocalUpdateAsync(ctx contractapi.TransactionContextInterface,
	collection string, updateData string, sampleCount int, baselineVersion int) error {

	// Get caller's organization ID
	clientMSPID, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return fmt.Errorf("failed to get client MSP ID: %v", err)
	}

	// Validate collection
	validCollections := map[string]string{
		"Org1MSP": CollectionVPSAOrg1Shards,
		"Org2MSP": CollectionVPSAOrg2Shards,
	}

	expectedCollection, ok := validCollections[clientMSPID]
	if !ok || collection != expectedCollection {
		return fmt.Errorf("invalid collection for organization %s", clientMSPID)
	}

	// Get current global model version
	currentVersion, err := a.GetLatestModelVersion(ctx)
	if err != nil {
		currentVersion = 0 // Start from version 0
	}

	nextVersion := currentVersion + 1

	// Create model update
	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return fmt.Errorf("failed to get timestamp: %v", err)
	}

	update := ModelUpdate{
		OrgID:           clientMSPID,
		Round:           0, // Not used in async mode
		Version:         nextVersion,
		UpdateData:      updateData,
		SampleCount:     sampleCount,
		BaselineVersion: baselineVersion,
		Timestamp:       txTimestamp.Seconds,
	}

	updateJSON, err := json.Marshal(update)
	if err != nil {
		return fmt.Errorf("failed to marshal update: %v", err)
	}

	// Store in PDC
	key := fmt.Sprintf("update_async_%d_%s", nextVersion, clientMSPID)
	err = ctx.GetStub().PutPrivateData(collection, key, updateJSON)
	if err != nil {
		return pdcWriteError(collection, err)
	}

	// Store an aggregation-safe public record for runnable FedAvg demo.
	publicKey := fmt.Sprintf("update_public_version_%d_%s", nextVersion, clientMSPID)
	err = ctx.GetStub().PutState(publicKey, updateJSON)
	if err != nil {
		return fmt.Errorf("failed to store public update record: %v", err)
	}

	// Immediately trigger aggregation
	return a.aggregateAsync(ctx, nextVersion, clientMSPID, updateData, sampleCount, baselineVersion)
}

// aggregateAsync performs asynchronous aggregation with staleness weighting
// Each update creates a new model version
// Staleness is calculated as: staleness = currentVersion - baselineVersion
// Staleness weight: staleWeight = 1.0 / (1.0 + staleness), reducing older updates' influence
func (a *AggregationContract) aggregateAsync(ctx contractapi.TransactionContextInterface,
	version int, orgID string, updateData string, sampleCount int, baselineVersion int) error {
	if sampleCount <= 0 {
		return fmt.Errorf("sampleCount must be > 0")
	}

	newWeights, err := parseWeights(updateData)
	if err != nil {
		return fmt.Errorf("invalid updateData: %v", err)
	}

	// Calculate staleness: how many versions old is this update
	staleness := version - 1 - baselineVersion
	if staleness < 0 {
		staleness = 0 // Future version shouldn't happen, treat as current
	}

	// Staleness weight: older updates contribute less
	// staleWeight = 1.0 / (1.0 + staleness)
	// e.g., staleness=0 -> weight=1.0, staleness=1 -> weight=0.5, staleness=2 -> weight=0.33
	staleWeight := 1.0 / (1.0 + float64(staleness))
	weightedSampleCount := float64(sampleCount) * staleWeight

	prevVersion := version - 1
	prevWeights := []float64{}
	prevSamples := 0.0
	if prevVersion > 0 {
		prevModel, err := a.GetGlobalModelByVersion(ctx, prevVersion)
		if err != nil {
			return fmt.Errorf("failed to get previous model v%d: %v", prevVersion, err)
		}

		prevWeights, err = parseWeights(prevModel.ModelData)
		if err != nil {
			return fmt.Errorf("invalid previous model weights: %v", err)
		}
		prevSamples = float64(prevModel.TotalSamples)

		if len(prevWeights) != len(newWeights) {
			return fmt.Errorf("weight dimension mismatch between v%d and incoming update", prevVersion)
		}
	}

	merged := make([]float64, len(newWeights))
	totalSamples := prevSamples + weightedSampleCount
	if totalSamples <= 0 {
		return fmt.Errorf("totalSamples must be > 0")
	}
	if prevVersion <= 0 {
		for i := range newWeights {
			merged[i] = newWeights[i]
		}
	} else {
		for i := range newWeights {
			merged[i] = (prevWeights[i]*prevSamples + newWeights[i]*weightedSampleCount) / totalSamples
		}
	}

	modelData, err := json.Marshal(merged)
	if err != nil {
		return fmt.Errorf("failed to marshal aggregated weights: %v", err)
	}

	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return fmt.Errorf("failed to get timestamp: %v", err)
	}

	globalModel := GlobalModel{
		Round:        0, // Not used in async mode
		Version:      version,
		ModelData:    string(modelData),
		TotalSamples: int(totalSamples),
		Participants: []string{orgID}, // Single participant in async
		Timestamp:    txTimestamp.Seconds,
	}

	modelJSON, err := json.Marshal(globalModel)
	if err != nil {
		return fmt.Errorf("failed to marshal global model: %v", err)
	}

	key := fmt.Sprintf("global_model_version_%d", version)
	err = ctx.GetStub().PutState(key, modelJSON)
	if err != nil {
		return fmt.Errorf("failed to store global model: %v", err)
	}

	// Update latest version pointer
	versionJSON, err := json.Marshal(version)
	if err != nil {
		return fmt.Errorf("failed to marshal version: %v", err)
	}

	return ctx.GetStub().PutState("latest_model_version", versionJSON)
}

// GetLatestModelVersion returns the latest model version in async mode
func (a *AggregationContract) GetLatestModelVersion(ctx contractapi.TransactionContextInterface) (int, error) {
	versionJSON, err := ctx.GetStub().GetState("latest_model_version")
	if err != nil {
		return 0, fmt.Errorf("failed to read latest version: %v", err)
	}
	if versionJSON == nil {
		return 0, nil // Version 0 if not initialized
	}

	var version int
	err = json.Unmarshal(versionJSON, &version)
	if err != nil {
		return 0, fmt.Errorf("failed to unmarshal version: %v", err)
	}

	return version, nil
}

// GetGlobalModelByVersion retrieves a global model by version number (async mode)
func (a *AggregationContract) GetGlobalModelByVersion(ctx contractapi.TransactionContextInterface,
	version int) (*GlobalModel, error) {

	key := fmt.Sprintf("global_model_version_%d", version)
	modelJSON, err := ctx.GetStub().GetState(key)
	if err != nil {
		return nil, fmt.Errorf("failed to read global model: %v", err)
	}
	if modelJSON == nil {
		return nil, fmt.Errorf("global model version %d not found", version)
	}

	var model GlobalModel
	err = json.Unmarshal(modelJSON, &model)
	if err != nil {
		return nil, fmt.Errorf("failed to unmarshal global model: %v", err)
	}

	return &model, nil
}

func parseWeights(raw string) ([]float64, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, fmt.Errorf("empty weights")
	}

	var weights []float64
	if err := json.Unmarshal([]byte(trimmed), &weights); err != nil {
		return nil, fmt.Errorf("expect JSON float array, e.g. [0.1,0.2]: %v", err)
	}
	if len(weights) == 0 {
		return nil, fmt.Errorf("weights cannot be empty")
	}
	return weights, nil
}

func pdcWriteError(collection string, err error) error {
	msg := err.Error()
	if strings.Contains(msg, "could not be found") {
		return fmt.Errorf(
			"failed to store update in PDC: collection %s not found; redeploy chaincode with PDC strategy enabled (--strategy vpsa): %v",
			collection,
			err,
		)
	}
	return fmt.Errorf("failed to store update in PDC: %v", err)
}
