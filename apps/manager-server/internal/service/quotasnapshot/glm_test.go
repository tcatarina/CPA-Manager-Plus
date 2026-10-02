package quotasnapshot

import (
	"context"
	"testing"
)

func TestGLMConfigCredentialSnapshotsStayKeyScoped(t *testing.T) {
	service := newQuotaSnapshotTestService(t, 50_000)
	ctx := context.Background()
	used := 27.0
	for _, index := range []string{"glm-a", "glm-b"} {
		_, err := service.Write(ctx, WriteRequest{Entries: []WriteEntry{{
			RowKey: index, Provider: "glm", Account: AccountTarget{AuthIndex: index},
			Windows: []WindowInput{{
				ProviderWindowID: "weekly", WindowKind: "weekly", WindowMode: "unknown",
				ModelScopeKind: "all", Source: "api_query", ObservedAtMS: 49_000,
				BoundaryAccuracy: "unknown", UsedPercent: &used, PlanType: "pro",
			}},
		}}})
		if err != nil {
			t.Fatal(err)
		}
	}
	result, err := service.Query(ctx, QueryRequest{Accounts: []QueryAccount{{
		RowKey: "glm-a", Provider: "glm", Account: AccountTarget{AuthIndex: "glm-a"},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 1 || len(result.Items[0].Windows) != 1 {
		t.Fatalf("unexpected result: %#v", result)
	}
	window := result.Items[0].Windows[0]
	if window.UsedPercent == nil || *window.UsedPercent != 27 || window.PlanType != "pro" {
		t.Fatalf("incorrect quota: %#v", window)
	}
}
