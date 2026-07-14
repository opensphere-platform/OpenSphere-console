package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"

	"github.com/jmespath/go-jmespath"
)

type outputOptions struct {
	Format, Query string
	Limit         int
	All           bool
	Explicit      bool
}
type formattedOutput struct {
	io.Writer
	options outputOptions
}

func parseOutputOptions(args []string) (outputOptions, []string, error) {
	opts := outputOptions{Format: "json", Limit: -1}
	clean := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		arg, name, value := args[i], "", ""
		if arg == "-o" || arg == "--output" || arg == "--query" || arg == "--limit" {
			if i+1 >= len(args) || strings.HasPrefix(args[i+1], "-") {
				return opts, nil, fmt.Errorf("%s 플래그에는 값이 필요합니다", arg)
			}
			name, value = arg, args[i+1]
			i++
		} else if strings.HasPrefix(arg, "-o=") {
			name, value = "-o", strings.TrimPrefix(arg, "-o=")
		} else if strings.HasPrefix(arg, "--output=") || strings.HasPrefix(arg, "--query=") || strings.HasPrefix(arg, "--limit=") {
			parts := strings.SplitN(arg, "=", 2)
			name, value = parts[0], parts[1]
		} else if arg == "--all" {
			opts.All = true
			continue
		} else {
			clean = append(clean, arg)
			continue
		}
		switch name {
		case "-o", "--output":
			opts.Format = strings.ToLower(value)
			opts.Explicit = true
		case "--query":
			opts.Query = value
		case "--limit":
			n, err := strconv.Atoi(value)
			if err != nil || n < 0 {
				return opts, nil, errors.New("--limit은 0 이상의 정수여야 합니다")
			}
			opts.Limit = n
		}
	}
	if opts.Format != "json" && opts.Format != "yaml" && opts.Format != "table" {
		return opts, nil, fmt.Errorf("지원하지 않는 출력 형식 %q; json, table, yaml 중 하나를 사용하세요", opts.Format)
	}
	return opts, clean, nil
}

func renderOutput(out io.Writer, b []byte, opts outputOptions) error {
	var value any
	if err := json.Unmarshal(b, &value); err != nil {
		_, writeErr := out.Write(append(b, '\n'))
		return writeErr
	}
	if opts.Query != "" {
		filtered, err := jmespath.Search(opts.Query, value)
		if err != nil {
			return fmt.Errorf("잘못된 JMESPath query: %w", err)
		}
		value = filtered
	}
	if rows, ok := value.([]any); ok && !opts.All && opts.Limit >= 0 && len(rows) > opts.Limit {
		value = rows[:opts.Limit]
	}
	switch opts.Format {
	case "json":
		enc := json.NewEncoder(out)
		enc.SetIndent("", "  ")
		return enc.Encode(value)
	case "yaml":
		return writeYAML(out, value, 0)
	case "table":
		return writeTable(out, value)
	}
	return nil
}

func writeYAML(out io.Writer, value any, indent int) error {
	pad := strings.Repeat("  ", indent)
	switch v := value.(type) {
	case map[string]any:
		for _, key := range sortedKeys(v) {
			if isScalar(v[key]) {
				fmt.Fprintf(out, "%s%s: %s\n", pad, key, yamlScalar(v[key]))
			} else {
				fmt.Fprintf(out, "%s%s:\n", pad, key)
				if err := writeYAML(out, v[key], indent+1); err != nil {
					return err
				}
			}
		}
	case []any:
		for _, item := range v {
			if isScalar(item) {
				fmt.Fprintf(out, "%s- %s\n", pad, yamlScalar(item))
			} else {
				fmt.Fprintf(out, "%s-\n", pad)
				if err := writeYAML(out, item, indent+1); err != nil {
					return err
				}
			}
		}
	default:
		fmt.Fprintf(out, "%s%s\n", pad, yamlScalar(v))
	}
	return nil
}

func yamlScalar(v any) string {
	if v == nil {
		return "null"
	}
	if s, ok := v.(string); ok {
		b, _ := json.Marshal(s)
		return string(b)
	}
	return fmt.Sprint(v)
}
func isScalar(v any) bool {
	switch v.(type) {
	case map[string]any, []any:
		return false
	}
	return true
}
func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func writeTable(out io.Writer, value any) error {
	rows, ok := value.([]any)
	if !ok {
		rows = []any{value}
	}
	set := map[string]bool{}
	for _, row := range rows {
		if m, ok := row.(map[string]any); ok {
			for k := range m {
				set[k] = true
			}
		}
	}
	columns := make([]string, 0, len(set))
	for k := range set {
		columns = append(columns, k)
	}
	sort.Strings(columns)
	if len(columns) == 0 {
		_, err := fmt.Fprintln(out, "VALUE\n"+tableCell(value))
		return err
	}
	fmt.Fprintln(out, strings.ToUpper(strings.Join(columns, "\t")))
	for _, row := range rows {
		m, _ := row.(map[string]any)
		cells := make([]string, len(columns))
		for i, col := range columns {
			cells[i] = tableCell(m[col])
		}
		fmt.Fprintln(out, strings.Join(cells, "\t"))
	}
	return nil
}
func tableCell(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return strings.ReplaceAll(s, "\t", " ")
	}
	b, _ := json.Marshal(v)
	return string(b)
}
