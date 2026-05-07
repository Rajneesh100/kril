package telemetry

import (
	"context"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/rajneesh/starfish/pkg/storage"
	"github.com/rajneesh/starfish/pkg/storage/elastic"
	"github.com/rajneesh/starfish/pkg/storage/victoria"
	pb "github.com/rajneesh/starfish/pkg/telemetry/pb"
	"google.golang.org/grpc"
)

type Service struct {
	pb.UnimplementedTelemetryServiceServer
	es *elastic.Client
	vm *victoria.Client
}

func NewService(es *elastic.Client, vm *victoria.Client) *Service {
	return &Service{es: es, vm: vm}
}

func (s *Service) Register(srv *grpc.Server) {
	pb.RegisterTelemetryServiceServer(srv, s)
}

func (s *Service) PushMetric(ctx context.Context, req *pb.PushMetricRequest) (*pb.PushMetricResponse, error) {
	requestID := uuid.New().String()
	now := time.Now().UTC()

	if req.Timestamp != "" {
		if t, err := time.Parse(time.RFC3339, req.Timestamp); err == nil {
			now = t
		}
	}

	// Build service_log (full raw data)
	serviceLog := &storage.ServiceLog{
		RequestID:    requestID,
		ServiceName:  req.ServiceName,
		ProcessType:  req.ProcessType,
		Endpoint:     req.Endpoint,
		Timestamp:    now,
		IsSuccessful: req.IsSuccessful,
		LatencyMs:    req.LatencyMs,
	}

	methodFailure := false
	for _, ft := range req.ExecutionFlow {
		trace := storage.FunctionTrace{
			Index:           int(ft.Index),
			CurrentFunction: ft.CurrentFunction,
			ParentFunction:  ft.ParentFunction,
			Input:           ft.Input,
			Output:          ft.Output,
			LatencyMs:       ft.LatencyMs,
			HaveError:       ft.HaveError,
		}
		if ft.HaveError {
			methodFailure = true
		}
		for _, l := range ft.Logs {
			trace.Logs = append(trace.Logs, storage.LogEntry{
				Timestamp: l.Timestamp,
				Level:     l.Level,
				Message:   l.Message,
			})
		}
		for _, ec := range ft.ExternalCalls {
			trace.ExternalCalls = append(trace.ExternalCalls, storage.ExternalCall{URL: ec.Url})
		}
		serviceLog.ExecutionFlow = append(serviceLog.ExecutionFlow, trace)
	}

	// Build telemetry_log (lightweight, no input/output/logs)
	telemetryLog := &storage.TelemetryLog{
		RequestID:      requestID,
		Timestamp:      now,
		ServiceName:    req.ServiceName,
		ProcessType:    req.ProcessType,
		Endpoint:       req.Endpoint,
		MethodFailure:  methodFailure,
		ProcessFailure: !req.IsSuccessful,
		ProcessLatency: req.LatencyMs,
	}
	for _, ft := range req.ExecutionFlow {
		entry := storage.ExecutionMapEntry{
			Index:           int(ft.Index),
			CurrentFunction: ft.CurrentFunction,
			ParentFunction:  ft.ParentFunction,
			LatencyMs:       ft.LatencyMs,
			HaveError:       ft.HaveError,
		}
		for _, ec := range ft.ExternalCalls {
			entry.ExternalCalls = append(entry.ExternalCalls, storage.ExternalCall{URL: ec.Url})
		}
		telemetryLog.ExecutionMap = append(telemetryLog.ExecutionMap, entry)
	}

	// Fire and forget: store to ES + push metrics to VictoriaMetrics
	go func() {
		bgCtx := context.Background()
		if err := s.es.StoreServiceLog(bgCtx, serviceLog); err != nil {
			log.Printf("ERROR storing service_log %s: %v", requestID, err)
		}
		if err := s.es.StoreTelemetryLog(bgCtx, telemetryLog); err != nil {
			log.Printf("ERROR storing telemetry_log %s: %v", requestID, err)
		}
		if s.vm != nil {
			if err := s.vm.PushMetrics(bgCtx, telemetryLog); err != nil {
				log.Printf("ERROR pushing metrics to VM %s: %v", requestID, err)
			}
		}
	}()

	return &pb.PushMetricResponse{
		RequestId: requestID,
		Success:   true,
		Message:   "metric received",
	}, nil
}
