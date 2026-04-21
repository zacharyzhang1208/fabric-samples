package contract

import (
	"encoding/json"
	"fmt"
	"sort"
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
	SubmittedNodes  []string `json:"submittedNodes"`  // Node-level submitters for centralized mode
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

type AsyncSubmitResult struct {
	TxID      string `json:"txId"`
	Timestamp int64  `json:"timestamp"`
}

type AsyncPendingUpdate struct {
	TxID            string `json:"txId"`
	PublicKey       string `json:"publicKey"`
	OrgID           string `json:"orgId"`
	SampleCount     int    `json:"sampleCount"`
	BaselineVersion int    `json:"baselineVersion"`
	Timestamp       int64  `json:"timestamp"`
}

type AsyncUpdatePayload struct {
	TxID       string `json:"txId"`
	UpdateData string `json:"updateData"`
}

type AsyncAggregationResult struct {
	Version         int   `json:"version"`
	AggregatedCount int   `json:"aggregatedCount"`
	Timestamp       int64 `json:"timestamp"`
}

type AggregationTiming struct {
	Scope      string `json:"scope"`
	Round      int    `json:"round"`
	Version    int    `json:"version"`
	DurationMs int64  `json:"durationMs"`
	StartedAt  int64  `json:"startedAt"`
	EndedAt    int64  `json:"endedAt"`
}

func syncAggregationTimingKey(round int) string {
	return fmt.Sprintf("aggregation_timing_round_%d", round)
}

func asyncAggregationTimingKey(version int) string {
	return fmt.Sprintf("aggregation_timing_version_%d", version)
}

func syncLastSubmitTsKey(round int) string {
	return fmt.Sprintf("sync_last_submit_ts_round_%d", round)
}

func centralizedAggregationTimingKey(round int) string {
	return fmt.Sprintf("centralized_aggregation_timing_round_%d", round)
}

func centralizedLastSubmitTsKey(round int) string {
	return fmt.Sprintf("centralized_last_submit_ts_round_%d", round)
}

func storeNodeUpdate(
	ctx contractapi.TransactionContextInterface,
	collection string,
	round int,
	clientMSPID string,
	nodeID string,
	updateData string,
	sampleCount int,
) (*ModelUpdate, int64, error) {
	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return nil, 0, fmt.Errorf("failed to get timestamp: %v", err)
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
		return nil, 0, fmt.Errorf("failed to marshal update: %v", err)
	}

	privateKey := fmt.Sprintf("node_update_round_%d_%s_%s", round, clientMSPID, nodeID)
	if err := ctx.GetStub().PutPrivateData(collection, privateKey, updateJSON); err != nil {
		return nil, 0, pdcWriteError(collection, err)
	}

	publicKey := fmt.Sprintf("node_update_public_round_%d_%s_%s", round, clientMSPID, nodeID)
	if err := ctx.GetStub().PutState(publicKey, updateJSON); err != nil {
		return nil, 0, fmt.Errorf("failed to store public node update record: %v", err)
	}

	lastSubmitMs := txTimestamp.Seconds*1000 + int64(txTimestamp.Nanos)/1_000_000
	return &update, lastSubmitMs, nil
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

// InitCentralizedRound initializes a centralized FL round that aggregates node updates directly.
func (a *AggregationContract) InitCentralizedRound(ctx contractapi.TransactionContextInterface,
	round int, expectedParticipants int) error {
	existing, _ := a.GetRoundStatus(ctx, round)
	if existing != nil {
		if existing.ExpectedCount == expectedParticipants {
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
		SubmittedNodes:  []string{},
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

// SubmitLocalUpdateCentralized records one node's update for the centralized round flow.
func (a *AggregationContract) SubmitLocalUpdateCentralized(ctx contractapi.TransactionContextInterface,
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

	status, err := a.GetRoundStatus(ctx, round)
	if err != nil {
		return fmt.Errorf("round %d not initialized: %v", round, err)
	}

	if status.AggregationDone {
		return fmt.Errorf("round %d already completed", round)
	}

	participantKey := fmt.Sprintf("%s:%s", clientMSPID, nodeID)
	if containsString(status.SubmittedNodes, participantKey) {
		return nil
	}

	_, lastSubmitMs, err := storeNodeUpdate(ctx, collection, round, clientMSPID, nodeID, updateData, sampleCount)
	if err != nil {
		return err
	}

	status.SubmittedNodes = append(status.SubmittedNodes, participantKey)
	if !containsString(status.SubmittedOrgs, clientMSPID) {
		status.SubmittedOrgs = append(status.SubmittedOrgs, clientMSPID)
	}

	statusJSON, err := json.Marshal(status)
	if err != nil {
		return fmt.Errorf("failed to marshal status: %v", err)
	}

	statusKey := fmt.Sprintf("round_status_%d", round)
	if err := ctx.GetStub().PutState(statusKey, statusJSON); err != nil {
		return err
	}

	if err := ctx.GetStub().PutState(centralizedLastSubmitTsKey(round), []byte(fmt.Sprintf("%d", lastSubmitMs))); err != nil {
		return fmt.Errorf("failed to store centralized last submit timestamp: %v", err)
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

	lastSubmitMs := txTimestamp.Seconds*1000 + int64(txTimestamp.Nanos)/1_000_000
	if err := ctx.GetStub().PutState(syncLastSubmitTsKey(round), []byte(fmt.Sprintf("%d", lastSubmitMs))); err != nil {
		return fmt.Errorf("failed to store sync last submit timestamp: %v", err)
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

	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return fmt.Errorf("failed to get finalize timestamp: %v", err)
	}
	endedAtMs := txTimestamp.Seconds*1000 + int64(txTimestamp.Nanos)/1_000_000
	startedAtMs := endedAtMs
	if lastSubmitRaw, err := ctx.GetStub().GetState(syncLastSubmitTsKey(round)); err == nil && lastSubmitRaw != nil {
		var parsed int64
		if _, scanErr := fmt.Sscanf(string(lastSubmitRaw), "%d", &parsed); scanErr == nil {
			startedAtMs = parsed
		}
	}
	durationMs := int64(0)
	if endedAtMs >= startedAtMs {
		durationMs = endedAtMs - startedAtMs
	}

	timing := AggregationTiming{
		Scope:      "sync",
		Round:      round,
		DurationMs: durationMs,
		StartedAt:  startedAtMs,
		EndedAt:    endedAtMs,
	}
	timingJSON, err := json.Marshal(timing)
	if err != nil {
		return fmt.Errorf("failed to marshal sync aggregation timing: %v", err)
	}
	if err := ctx.GetStub().PutState(syncAggregationTimingKey(round), timingJSON); err != nil {
		return fmt.Errorf("failed to store sync aggregation timing: %v", err)
	}

	return nil
}

// FinalizeCentralizedRound performs aggregation directly over all node-level submissions.
func (a *AggregationContract) FinalizeCentralizedRound(ctx contractapi.TransactionContextInterface, round int) error {
	status, err := a.GetRoundStatus(ctx, round)
	if err != nil {
		return fmt.Errorf("round %d not initialized: %v", round, err)
	}

	if status.AggregationDone {
		return nil
	}

	if len(status.SubmittedNodes) < status.ExpectedCount {
		return fmt.Errorf(
			"round %d not ready: %d/%d submitted",
			round,
			len(status.SubmittedNodes),
			status.ExpectedCount,
		)
	}

	if err := a.aggregateCentralized(ctx, round, status.SubmittedNodes); err != nil {
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

	currentRound, err := a.GetCurrentRound(ctx)
	if err != nil {
		return fmt.Errorf("failed to get current round: %v", err)
	}

	if round == currentRound+1 {
		if err := a.IncrementRound(ctx); err != nil {
			return fmt.Errorf("failed to increment round: %v", err)
		}
	}

	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return fmt.Errorf("failed to get finalize timestamp: %v", err)
	}
	endedAtMs := txTimestamp.Seconds*1000 + int64(txTimestamp.Nanos)/1_000_000
	startedAtMs := endedAtMs
	if lastSubmitRaw, err := ctx.GetStub().GetState(centralizedLastSubmitTsKey(round)); err == nil && lastSubmitRaw != nil {
		var parsed int64
		if _, scanErr := fmt.Sscanf(string(lastSubmitRaw), "%d", &parsed); scanErr == nil {
			startedAtMs = parsed
		}
	}
	durationMs := int64(0)
	if endedAtMs >= startedAtMs {
		durationMs = endedAtMs - startedAtMs
	}

	timing := AggregationTiming{
		Scope:      "centralized",
		Round:      round,
		DurationMs: durationMs,
		StartedAt:  startedAtMs,
		EndedAt:    endedAtMs,
	}
	timingJSON, err := json.Marshal(timing)
	if err != nil {
		return fmt.Errorf("failed to marshal centralized aggregation timing: %v", err)
	}
	if err := ctx.GetStub().PutState(centralizedAggregationTimingKey(round), timingJSON); err != nil {
		return fmt.Errorf("failed to store centralized aggregation timing: %v", err)
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

func (a *AggregationContract) aggregateCentralized(ctx contractapi.TransactionContextInterface,
	round int, participants []string) error {
	if len(participants) == 0 {
		return fmt.Errorf("no participants for round %d", round)
	}

	var weightedSum []float64
	totalSamples := 0

	for _, participant := range participants {
		orgID, nodeID, ok := strings.Cut(participant, ":")
		if !ok || strings.TrimSpace(orgID) == "" || strings.TrimSpace(nodeID) == "" {
			return fmt.Errorf("invalid participant key %q", participant)
		}

		publicKey := fmt.Sprintf("node_update_public_round_%d_%s_%s", round, orgID, nodeID)
		updateJSON, err := ctx.GetStub().GetState(publicKey)
		if err != nil {
			return fmt.Errorf("failed to read update for %s: %v", participant, err)
		}
		if updateJSON == nil {
			return fmt.Errorf("missing update for round %d, participant %s", round, participant)
		}

		var update ModelUpdate
		if err := json.Unmarshal(updateJSON, &update); err != nil {
			return fmt.Errorf("failed to parse update for %s: %v", participant, err)
		}
		if update.SampleCount <= 0 {
			return fmt.Errorf("invalid sample count from %s: %d", participant, update.SampleCount)
		}

		weights, err := parseWeights(update.UpdateData)
		if err != nil {
			return fmt.Errorf("invalid updateData from %s: %v", participant, err)
		}

		if weightedSum == nil {
			weightedSum = make([]float64, len(weights))
		}
		if len(weights) != len(weightedSum) {
			return fmt.Errorf("weight dimension mismatch for %s", participant)
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
		Version:      0,
		ModelData:    string(modelData),
		TotalSamples: totalSamples,
		Participants: participants,
		Timestamp:    txTimestamp.Seconds,
	}

	modelJSON, err := json.Marshal(globalModel)
	if err != nil {
		return fmt.Errorf("failed to marshal aggregated global model: %v", err)
	}

	key := fmt.Sprintf("global_model_round_%d", round)
	return ctx.GetStub().PutState(key, modelJSON)
}

// GetSyncAggregationTiming retrieves the pure internal sync aggregation duration.
func (a *AggregationContract) GetSyncAggregationTiming(ctx contractapi.TransactionContextInterface, round int) (*AggregationTiming, error) {
	key := syncAggregationTimingKey(round)
	timingJSON, err := ctx.GetStub().GetState(key)
	if err != nil {
		return nil, fmt.Errorf("failed to read sync aggregation timing: %v", err)
	}
	if timingJSON == nil {
		return nil, fmt.Errorf("sync aggregation timing for round %d not found", round)
	}

	var timing AggregationTiming
	if err := json.Unmarshal(timingJSON, &timing); err != nil {
		return nil, fmt.Errorf("failed to unmarshal sync aggregation timing: %v", err)
	}

	return &timing, nil
}

// GetCentralizedAggregationTiming retrieves the pure internal centralized aggregation duration.
func (a *AggregationContract) GetCentralizedAggregationTiming(ctx contractapi.TransactionContextInterface, round int) (*AggregationTiming, error) {
	key := centralizedAggregationTimingKey(round)
	timingJSON, err := ctx.GetStub().GetState(key)
	if err != nil {
		return nil, fmt.Errorf("failed to read centralized aggregation timing: %v", err)
	}
	if timingJSON == nil {
		return nil, fmt.Errorf("centralized aggregation timing for round %d not found", round)
	}

	var timing AggregationTiming
	if err := json.Unmarshal(timingJSON, &timing); err != nil {
		return nil, fmt.Errorf("failed to unmarshal centralized aggregation timing: %v", err)
	}

	return &timing, nil
}

// ============================================================================
// ASYNCHRONOUS FL METHODS
// ============================================================================

const defaultAsyncBatchSize = 5

const (
	asyncUpdateMetaPrefix     = "async_update_meta_"
	asyncUpdatePayloadPrefix  = "async_update_payload_"
	asyncConsumedPrefix       = "async_consumed_"
	asyncUpdateSubmittedEvent = "async_update_submitted"
	asyncModelAggregatedEvent = "async_model_aggregated"
)

func asyncUpdateMetaKey(txID string) string {
	return fmt.Sprintf("%s%s", asyncUpdateMetaPrefix, txID)
}

func asyncUpdatePayloadKey(txID string) string {
	return fmt.Sprintf("%s%s", asyncUpdatePayloadPrefix, txID)
}

func asyncPrivateUpdateKey(txID string) string {
	return fmt.Sprintf("update_async_%s", txID)
}

func asyncConsumedKey(txID string) string {
	return fmt.Sprintf("%s%s", asyncConsumedPrefix, txID)
}

func (a *AggregationContract) getAsyncUpdatePayload(
	ctx contractapi.TransactionContextInterface,
	txID string,
) (*AsyncUpdatePayload, error) {
	payloadJSON, err := ctx.GetStub().GetState(asyncUpdatePayloadKey(txID))
	if err != nil {
		return nil, fmt.Errorf("failed to read async update payload %s: %v", txID, err)
	}
	if payloadJSON != nil {
		var payload AsyncUpdatePayload
		if err := json.Unmarshal(payloadJSON, &payload); err != nil {
			return nil, fmt.Errorf("failed to parse async update payload %s: %v", txID, err)
		}
		return &payload, nil
	}
	return nil, fmt.Errorf("async update payload %s not found", txID)
}

func (a *AggregationContract) listPendingAsyncUpdates(
	ctx contractapi.TransactionContextInterface,
	limit int,
) ([]AsyncPendingUpdate, error) {
	iterator, err := ctx.GetStub().GetStateByRange(asyncUpdateMetaPrefix, asyncUpdateMetaPrefix+"~")
	if err != nil {
		return nil, fmt.Errorf("failed to scan pending async updates: %v", err)
	}
	defer iterator.Close()

	updates := make([]AsyncPendingUpdate, 0)
	for iterator.HasNext() {
		entry, err := iterator.Next()
		if err != nil {
			return nil, fmt.Errorf("failed to read pending async update entry: %v", err)
		}

		txID := strings.TrimPrefix(entry.Key, asyncUpdateMetaPrefix)
		consumed, err := ctx.GetStub().GetState(asyncConsumedKey(txID))
		if err != nil {
			return nil, fmt.Errorf("failed to read async consumed marker for %s: %v", txID, err)
		}
		if consumed != nil {
			continue
		}

		var update AsyncPendingUpdate
		if err := json.Unmarshal(entry.Value, &update); err != nil {
			return nil, fmt.Errorf("failed to parse async update metadata %s: %v", txID, err)
		}
		update.TxID = txID
		update.PublicKey = entry.Key
		updates = append(updates, update)
	}

	sort.Slice(updates, func(i, j int) bool {
		if updates[i].Timestamp == updates[j].Timestamp {
			return updates[i].TxID < updates[j].TxID
		}
		return updates[i].Timestamp < updates[j].Timestamp
	})

	if limit > 0 && len(updates) > limit {
		updates = updates[:limit]
	}
	return updates, nil
}

// GetPendingAsyncUpdates returns earliest pending async updates by timestamp.
func (a *AggregationContract) GetPendingAsyncUpdates(
	ctx contractapi.TransactionContextInterface,
	limit int,
) ([]AsyncPendingUpdate, error) {
	return a.listPendingAsyncUpdates(ctx, limit)
}

// SubmitLocalUpdateAsync stores an async update by txid and emits a lightweight submit event.
func (a *AggregationContract) SubmitLocalUpdateAsync(
	ctx contractapi.TransactionContextInterface,
	collection string,
	updateData string,
	sampleCount int,
	baselineVersion int,
) (string, error) {
	clientMSPID, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return "", fmt.Errorf("failed to get client MSP ID: %v", err)
	}

	validCollections := map[string]string{
		"Org1MSP": CollectionVPSAOrg1Shards,
		"Org2MSP": CollectionVPSAOrg2Shards,
	}

	expectedCollection, ok := validCollections[clientMSPID]
	if !ok || collection != expectedCollection {
		return "", fmt.Errorf("invalid collection for organization %s", clientMSPID)
	}

	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return "", fmt.Errorf("failed to get timestamp: %v", err)
	}

	update := ModelUpdate{
		OrgID:           clientMSPID,
		Round:           0,
		Version:         0,
		UpdateData:      updateData,
		SampleCount:     sampleCount,
		BaselineVersion: baselineVersion,
		Timestamp:       txTimestamp.Seconds,
	}

	updateJSON, err := json.Marshal(update)
	if err != nil {
		return "", fmt.Errorf("failed to marshal update: %v", err)
	}

	txID := ctx.GetStub().GetTxID()
	if err := ctx.GetStub().PutPrivateData(collection, asyncPrivateUpdateKey(txID), updateJSON); err != nil {
		return "", pdcWriteError(collection, err)
	}
	meta := AsyncPendingUpdate{
		TxID:            txID,
		PublicKey:       asyncUpdateMetaKey(txID),
		OrgID:           update.OrgID,
		SampleCount:     update.SampleCount,
		BaselineVersion: update.BaselineVersion,
		Timestamp:       update.Timestamp,
	}
	metaJSON, err := json.Marshal(meta)
	if err != nil {
		return "", fmt.Errorf("failed to marshal async update metadata: %v", err)
	}
	payload := AsyncUpdatePayload{
		TxID:       txID,
		UpdateData: update.UpdateData,
	}
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("failed to marshal async update payload: %v", err)
	}
	if err := ctx.GetStub().PutState(asyncUpdateMetaKey(txID), metaJSON); err != nil {
		return "", fmt.Errorf("failed to store public async update metadata: %v", err)
	}
	if err := ctx.GetStub().PutState(asyncUpdatePayloadKey(txID), payloadJSON); err != nil {
		return "", fmt.Errorf("failed to store public async update payload: %v", err)
	}

	result := AsyncSubmitResult{
		TxID:      txID,
		Timestamp: txTimestamp.Seconds,
	}
	resultJSON, err := json.Marshal(result)
	if err != nil {
		return "", fmt.Errorf("failed to marshal async submit result: %v", err)
	}

	if err := ctx.GetStub().SetEvent(asyncUpdateSubmittedEvent, resultJSON); err != nil {
		return "", fmt.Errorf("failed to emit async submit event: %v", err)
	}

	return string(resultJSON), nil
}

// AggregateAsyncBatch aggregates a caller-specified batch of async txids.
func (a *AggregationContract) AggregateAsyncBatch(
	ctx contractapi.TransactionContextInterface,
	txIDsJSON string,
	minUpdates int,
) (string, error) {
	var txIDs []string
	if err := json.Unmarshal([]byte(txIDsJSON), &txIDs); err != nil {
		return "", fmt.Errorf("failed to parse async batch txids: %v", err)
	}
	if len(txIDs) == 0 {
		return "", fmt.Errorf("async batch txids cannot be empty")
	}

	requiredUpdates := defaultAsyncBatchSize
	if minUpdates > 0 && minUpdates < requiredUpdates {
		requiredUpdates = minUpdates
	}
	if len(txIDs) < requiredUpdates {
		return "", fmt.Errorf("not enough async updates to aggregate: %d/%d", len(txIDs), requiredUpdates)
	}

	seen := make(map[string]struct{}, len(txIDs))
	currentVersion, err := a.GetLatestModelVersion(ctx)
	if err != nil {
		currentVersion = 0
	}
	nextVersion := currentVersion + 1

	prevWeights := []float64{}
	prevSamples := 0.0
	if currentVersion > 0 {
		prevModel, err := a.GetGlobalModelByVersion(ctx, currentVersion)
		if err != nil {
			return "", fmt.Errorf("failed to get previous model v%d: %v", currentVersion, err)
		}

		prevWeights, err = parseWeights(prevModel.ModelData)
		if err != nil {
			return "", fmt.Errorf("invalid previous model weights: %v", err)
		}
		prevSamples = float64(prevModel.TotalSamples)
	}

	var weightedSum []float64
	if len(prevWeights) > 0 {
		weightedSum = make([]float64, len(prevWeights))
		for i := range prevWeights {
			weightedSum[i] = prevWeights[i] * prevSamples
		}
	}

	totalSamples := prevSamples
	participants := []string{}
	aggregatedTxIDs := make([]string, 0, len(txIDs))
	latestSelectedUpdateMs := int64(0)

	for _, txID := range txIDs {
		if txID == "" {
			return "", fmt.Errorf("async batch txid cannot be empty")
		}
		if _, exists := seen[txID]; exists {
			return "", fmt.Errorf("duplicate async batch txid: %s", txID)
		}
		seen[txID] = struct{}{}

		consumed, err := ctx.GetStub().GetState(asyncConsumedKey(txID))
		if err != nil {
			return "", fmt.Errorf("failed to read async consumed marker for %s: %v", txID, err)
		}
		if consumed != nil {
			return "", fmt.Errorf("async update %s already consumed", txID)
		}

		metaJSON, err := ctx.GetStub().GetState(asyncUpdateMetaKey(txID))
		if err != nil {
			return "", fmt.Errorf("failed to read async update metadata %s: %v", txID, err)
		}
		if metaJSON == nil {
			return "", fmt.Errorf("async update metadata %s not found", txID)
		}

		var updateMeta AsyncPendingUpdate
		if err := json.Unmarshal(metaJSON, &updateMeta); err != nil {
			return "", fmt.Errorf("failed to parse async update metadata %s: %v", txID, err)
		}
		if updateMeta.SampleCount <= 0 {
			return "", fmt.Errorf("invalid sampleCount in %s: %d", txID, updateMeta.SampleCount)
		}

		payload, err := a.getAsyncUpdatePayload(ctx, txID)
		if err != nil {
			return "", err
		}

		newWeights, err := parseWeights(payload.UpdateData)
		if err != nil {
			return "", fmt.Errorf("invalid updateData in %s: %v", txID, err)
		}

		if weightedSum == nil {
			weightedSum = make([]float64, len(newWeights))
		}
		if len(newWeights) != len(weightedSum) {
			return "", fmt.Errorf("weight dimension mismatch in %s", txID)
		}

		staleness := currentVersion - updateMeta.BaselineVersion
		if staleness < 0 {
			staleness = 0
		}
		staleWeight := 1.0 / (1.0 + float64(staleness))
		weightedSampleCount := float64(updateMeta.SampleCount) * staleWeight

		for i := range newWeights {
			weightedSum[i] += newWeights[i] * weightedSampleCount
		}
		totalSamples += weightedSampleCount

		if !containsString(participants, updateMeta.OrgID) {
			participants = append(participants, updateMeta.OrgID)
		}
		aggregatedTxIDs = append(aggregatedTxIDs, txID)
		updateMs := updateMeta.Timestamp * 1000
		if updateMs > latestSelectedUpdateMs {
			latestSelectedUpdateMs = updateMs
		}
	}

	if len(aggregatedTxIDs) < requiredUpdates {
		return "", fmt.Errorf("not enough async updates to aggregate: %d/%d", len(aggregatedTxIDs), requiredUpdates)
	}
	if totalSamples <= 0 {
		return "", fmt.Errorf("totalSamples must be > 0")
	}

	merged := make([]float64, len(weightedSum))
	for i := range weightedSum {
		merged[i] = weightedSum[i] / totalSamples
	}

	modelData, err := json.Marshal(merged)
	if err != nil {
		return "", fmt.Errorf("failed to marshal aggregated weights: %v", err)
	}

	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return "", fmt.Errorf("failed to get timestamp: %v", err)
	}

	globalModel := GlobalModel{
		Round:        0,
		Version:      nextVersion,
		ModelData:    string(modelData),
		TotalSamples: int(totalSamples),
		Participants: participants,
		Timestamp:    txTimestamp.Seconds,
	}

	modelJSON, err := json.Marshal(globalModel)
	if err != nil {
		return "", fmt.Errorf("failed to marshal global model: %v", err)
	}

	key := fmt.Sprintf("global_model_version_%d", nextVersion)
	if err := ctx.GetStub().PutState(key, modelJSON); err != nil {
		return "", fmt.Errorf("failed to store global model: %v", err)
	}

	versionJSON, err := json.Marshal(nextVersion)
	if err != nil {
		return "", fmt.Errorf("failed to marshal version: %v", err)
	}
	if err := ctx.GetStub().PutState("latest_model_version", versionJSON); err != nil {
		return "", err
	}

	consumedMarker := map[string]interface{}{
		"version":   nextVersion,
		"timestamp": txTimestamp.Seconds,
	}
	consumedJSON, err := json.Marshal(consumedMarker)
	if err != nil {
		return "", fmt.Errorf("failed to marshal async consumed marker: %v", err)
	}

	for _, txID := range aggregatedTxIDs {
		if err := ctx.GetStub().PutState(asyncConsumedKey(txID), consumedJSON); err != nil {
			return "", fmt.Errorf("failed to store async consumed marker for %s: %v", txID, err)
		}
	}

	result := AsyncAggregationResult{
		Version:         nextVersion,
		AggregatedCount: len(aggregatedTxIDs),
		Timestamp:       txTimestamp.Seconds,
	}
	resultJSON, err := json.Marshal(result)
	if err != nil {
		return "", fmt.Errorf("failed to marshal async aggregation result: %v", err)
	}
	if err := ctx.GetStub().SetEvent(asyncModelAggregatedEvent, resultJSON); err != nil {
		return "", fmt.Errorf("failed to emit async aggregation event: %v", err)
	}

	endedAtMs := txTimestamp.Seconds*1000 + int64(txTimestamp.Nanos)/1_000_000
	startedAtMs := latestSelectedUpdateMs
	if startedAtMs <= 0 || startedAtMs > endedAtMs {
		startedAtMs = endedAtMs
	}
	durationMs := endedAtMs - startedAtMs

	timing := AggregationTiming{
		Scope:      "async",
		Version:    nextVersion,
		DurationMs: durationMs,
		StartedAt:  startedAtMs,
		EndedAt:    endedAtMs,
	}
	timingJSON, err := json.Marshal(timing)
	if err != nil {
		return "", fmt.Errorf("failed to marshal async aggregation timing: %v", err)
	}
	if err := ctx.GetStub().PutState(asyncAggregationTimingKey(nextVersion), timingJSON); err != nil {
		return "", fmt.Errorf("failed to store async aggregation timing: %v", err)
	}

	return string(resultJSON), nil
}

// GetAsyncAggregationTiming retrieves the pure internal async aggregation duration.
func (a *AggregationContract) GetAsyncAggregationTiming(ctx contractapi.TransactionContextInterface, version int) (*AggregationTiming, error) {
	key := asyncAggregationTimingKey(version)
	timingJSON, err := ctx.GetStub().GetState(key)
	if err != nil {
		return nil, fmt.Errorf("failed to read async aggregation timing: %v", err)
	}
	if timingJSON == nil {
		return nil, fmt.Errorf("async aggregation timing for version %d not found", version)
	}

	var timing AggregationTiming
	if err := json.Unmarshal(timingJSON, &timing); err != nil {
		return nil, fmt.Errorf("failed to unmarshal async aggregation timing: %v", err)
	}

	return &timing, nil
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
