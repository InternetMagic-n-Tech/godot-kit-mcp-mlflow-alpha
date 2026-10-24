How to diff:


File: `diff -u original-file.txt modified-file.txt > changes.patch`

String: `diff -u <(echo -e "FROM qwen2.5\nPARAMETER temperature 0.7") <(echo -e "FROM qwen2.5\nPARAMETER temperature 0.2")`

Qwen-2.5 (do the same for coder)

```
ollama show --template qwen2.5:14b --verbose > model-files/patches/qwen2.5:14b-tool-template.old.tooltemplate
cp -f model-files/patches/qwen2.5:14b-tool-template.old.tooltemplate model-files/patches/qwen2.5:14b-tool-template.new.tooltemplate
```

Make the change for coder `qwen2.5-coder:14b-tool-template.new.tooltemplate:30-36` 

```
{{ else if eq .Role "assistant" }}<|im_start|>assistant
{{- if .Content }}
{{ .Content }}
{{- end }}
{{- range .ToolCalls }}
<tool_call>
{"name": "{{ .Function.Name }}", "arguments": {{ .Function.Arguments }}}
</tool_call>
{{- end }}{{ if not $last }}<|im_end|>
{{ end }}
```


`diff -u model-files/patches/qwen2.5-coder:14b-tool-template.old.tooltemplate model-files/patches/qwen2.5-coder:14b-tool-template.new.tooltemplate > model-files/patches/qwen2.5-coder:14b-tool-template.patch`


Make the change for base `qwen2.5:14b-tool-template.new.tooltemplate:29-35` 

```
{{ else if eq .Role "assistant" }}<|im_start|>assistant
{{- if .Content }}
{{ .Content }}
{{- end }}
{{- range .ToolCalls }}
<tool_call>
{"name": "{{ .Function.Name }}", "arguments": {{ .Function.Arguments }}}
</tool_call>
{{- end }}{{ if not $last }}<|im_end|>
{{ end }}
```


`diff -u model-files/patches/qwen2.5:14b-tool-template.old.tooltemplate model-files/patches/qwen2.5:14b-tool-template.new.tooltemplate > model-files/patches/qwen2.5:14b-tool-template.patch`


CHECK THAT YOUR IDE DOES NOT CREATE NEW LINES IN THESE FILES!!!!
