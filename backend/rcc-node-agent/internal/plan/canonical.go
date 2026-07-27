package plan

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

// CanonicalContentDigest recomputes the digest an approver bound, from the
// plan's own typed fields.
//
// Checking that ContentDigest merely *looks* like a digest proves nothing: a
// control center could hand the agent parameters that differ from the ones a
// human approved and still present a well-formed digest string. The agent
// therefore rebuilds the canonical (operation, parameters) document itself and
// demands an exact match, so the bytes that run are provably the bytes that
// were reviewed.
//
// The canonical form must stay byte-identical to `contentDigest()` in
// backend/opensphere-console-backend/operation-api.js:
//
//	sha256( JSON.stringify( canonicalize({ operation, parameters }) ) )
//
// where canonicalize sorts object keys at every level. Go's encoder sorts map
// keys for us; HTML escaping is disabled because JSON.stringify does not escape
// <, > or &.
func (p *Plan) CanonicalContentDigest() (string, error) {
	parameters, err := p.canonicalParameters()
	if err != nil {
		return "", err
	}
	document := map[string]any{
		"operation":  p.Operation,
		"parameters": parameters,
	}
	// A policy change must invalidate work approved under the old rules, so the
	// governing policy version is part of the content an approval binds. An
	// ungoverned operation carries no policy and hashes exactly as before,
	// which keeps Stage 1 and Stage 2 digests unchanged.
	if p.Policy != nil {
		document["policy"] = map[string]any{
			"policyId":      p.Policy.PolicyID,
			"policyVersion": p.Policy.PolicyVersion,
		}
	}
	encoded, err := canonicalJSON(document)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(encoded)
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

// VerifyContentDigest fails closed when the plan's declared digest does not
// match the parameters it actually carries.
func (p *Plan) VerifyContentDigest() error {
	expected, err := p.CanonicalContentDigest()
	if err != nil {
		return err
	}
	if expected != p.ContentDigest {
		return fmt.Errorf("plan content digest mismatch: parameters hash to %s but the plan claims %s",
			expected, p.ContentDigest)
	}
	return nil
}

// canonicalParameters mirrors normalizeParameters() in the backend exactly.
// Every key the backend stores must appear here, with the same name and type,
// or the digests will not agree.
func (p *Plan) canonicalParameters() (map[string]any, error) {
	switch p.Operation {
	case OpJournalQuery:
		if p.Journal == nil {
			return nil, fmt.Errorf("journal arguments are missing")
		}
		units := p.Journal.Units
		if units == nil {
			units = []string{}
		}
		// maxBytes is a transport bound the backend adds to the plan; it is not
		// part of the approved parameters and must not enter the digest.
		return map[string]any{
			"units":    units,
			"priority": p.Journal.Priority,
			"since":    p.Journal.Since,
			"until":    p.Journal.Until,
			"cursor":   p.Journal.Cursor,
			"lines":    p.Journal.Lines,
		}, nil
	case OpServiceRestart:
		if p.Service == nil {
			return nil, fmt.Errorf("service arguments are missing")
		}
		return map[string]any{"unit": p.Service.Unit}, nil
	case OpHostReboot:
		if p.Reboot == nil {
			return nil, fmt.Errorf("reboot arguments are missing")
		}
		// drainConfirmed is maintenance evidence decided after approval; only
		// the operator-chosen deadline is part of the approved content.
		return map[string]any{"deadlineSeconds": p.Reboot.DeadlineSeconds}, nil
	case OpPackageRefresh:
		if p.PackageRefresh == nil {
			return nil, fmt.Errorf("packageRefresh arguments are missing")
		}
		return map[string]any{"manager": p.PackageRefresh.Manager}, nil
	case OpPackageUpdate:
		if p.PackageUpdate == nil {
			return nil, fmt.Errorf("packageUpdate arguments are missing")
		}
		// The package set is part of what was approved, so every name and pin
		// enters the digest. Order is fixed by the backend, not re-sorted here:
		// re-sorting would let two different approved lists hash the same.
		packages := make([]any, 0, len(p.PackageUpdate.Packages))
		for _, target := range p.PackageUpdate.Packages {
			packages = append(packages, map[string]any{
				"name":    target.Name,
				"version": target.Version,
			})
		}
		return map[string]any{
			"manager":      p.PackageUpdate.Manager,
			"packages":     packages,
			"securityOnly": p.PackageUpdate.SecurityOnly,
		}, nil
	case OpKernelUpdate:
		if p.KernelUpdate == nil {
			return nil, fmt.Errorf("kernelUpdate arguments are missing")
		}
		// rebootAfter is not part of the approved content: it is always false
		// and is refused at validation, so including it would only add a field
		// that can never vary.
		return map[string]any{
			"manager":       p.KernelUpdate.Manager,
			"targetRelease": p.KernelUpdate.TargetRelease,
		}, nil

	// Stage 4. The observed pre-state is part of the approved content, not
	// context around it. An approver looked at a specific interface, a specific
	// filesystem size, a specific booted image; binding those into the digest is
	// what makes "the host changed since you reviewed this" a detectable
	// condition rather than an assumption.
	case OpNetworkConfigure:
		if p.Network == nil {
			return nil, fmt.Errorf("network arguments are missing")
		}
		a := p.Network
		return map[string]any{
			"adapter":         a.Adapter,
			"connection":      a.Connection,
			"interface":       a.Interface,
			"method":          a.Method,
			"addresses":       orEmpty(a.Addresses),
			"gateway":         a.Gateway,
			"dns":             orEmpty(a.DNS),
			"searchDomains":   orEmpty(a.SearchDomains),
			"mtu":             a.MTU,
			"rollbackSeconds": a.RollbackSeconds,
			"preState":        canonicalNetworkPreState(a.PreState),
		}, nil
	case OpMountConfigure:
		if p.Mount == nil {
			return nil, fmt.Errorf("mount arguments are missing")
		}
		a := p.Mount
		return map[string]any{
			"adapter":        a.Adapter,
			"filesystemUuid": a.FilesystemUUID,
			"mountPoint":     a.MountPoint,
			"fsType":         a.FSType,
			"readOnly":       a.ReadOnly,
			"noExec":         a.NoExec,
			"noSuid":         a.NoSuid,
			"noDev":          a.NoDev,
			"preState":       canonicalMountPreState(a.PreState),
		}, nil
	case OpFilesystemGrow:
		if p.FilesystemGrow == nil {
			return nil, fmt.Errorf("filesystemGrow arguments are missing")
		}
		a := p.FilesystemGrow
		return map[string]any{
			"adapter":    a.Adapter,
			"mountPoint": a.MountPoint,
			"preState":   canonicalGrowPreState(a.PreState),
		}, nil
	case OpOSImageStage, OpOSImageRollback:
		if p.OSImage == nil {
			return nil, fmt.Errorf("osImage arguments are missing")
		}
		a := p.OSImage
		// rebootAfter is excluded for the same reason as kernel.update: it is
		// always false and refused at validation, so it can never vary.
		return map[string]any{
			"adapter":  a.Adapter,
			"image":    a.Image,
			"preState": canonicalImagePreState(a.PreState),
		}, nil
	case OpSSHBan, OpSSHUnban:
		if p.SSHBan == nil {
			return nil, fmt.Errorf("sshBan arguments are missing")
		}
		return map[string]any{
			"jail":           p.SSHBan.Jail,
			"address":        p.SSHBan.Address,
			"expectedBanned": p.SSHBan.ExpectedBanned,
		}, nil
	case OpSSHProtectionEnable:
		if p.SSHProtection == nil {
			return nil, fmt.Errorf("sshProtection arguments are missing")
		}
		return map[string]any{
			"provider":              p.SSHProtection.Provider,
			"jail":                  p.SSHProtection.Jail,
			"profile":               p.SSHProtection.Profile,
			"packageVersion":        p.SSHProtection.PackageVersion,
			"expectedProfileDigest": p.SSHProtection.ExpectedProfileDigest,
			"expectedInstalled":     p.SSHProtection.ExpectedInstalled,
			"expectedActive":        p.SSHProtection.ExpectedActive,
			"protectedAddresses":    orEmpty(p.SSHProtection.ProtectedAddresses),
		}, nil
	default:
		return nil, fmt.Errorf("unknown operation %q", p.Operation)
	}
}

// orEmpty keeps a nil slice hashing as `[]`, which is what JSON.stringify
// produces for the backend's own empty arrays.
func orEmpty(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

// The pre-state canonicalisers exist so a nil block hashes as JSON null rather
// than as a typed nil pointer, exactly as the backend emits it.
func canonicalNetworkPreState(state *NetworkPreState) any {
	if state == nil {
		return nil
	}
	return map[string]any{
		"method":                state.Method,
		"addresses":             orEmpty(state.Addresses),
		"gateway":               state.Gateway,
		"mtu":                   state.MTU,
		"defaultRouteInterface": state.DefaultRouteInterface,
	}
}

func canonicalMountPreState(state *MountPreState) any {
	if state == nil {
		return nil
	}
	return map[string]any{
		"fsType":     state.FSType,
		"sizeBytes":  state.SizeBytes,
		"mountedAt":  state.MountedAt,
		"deviceName": state.DeviceName,
	}
}

func canonicalGrowPreState(state *FilesystemGrowPreState) any {
	if state == nil {
		return nil
	}
	return map[string]any{
		"device":      state.Device,
		"fsType":      state.FSType,
		"sizeBytes":   state.SizeBytes,
		"deviceBytes": state.DeviceBytes,
	}
}

func canonicalImagePreState(state *OSImagePreState) any {
	if state == nil {
		return nil
	}
	return map[string]any{
		"model":             state.Model,
		"bootedDigest":      state.BootedDigest,
		"bootedVersion":     state.BootedVersion,
		"rollbackAvailable": state.RollbackAvailable,
	}
}

// canonicalJSON encodes with sorted keys and no HTML escaping, matching
// JSON.stringify over a key-sorted document.
func canonicalJSON(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	// Encode appends a newline that JSON.stringify does not produce.
	return bytes.TrimRight(buffer.Bytes(), "\n"), nil
}
