"""Token-bounded embedding passages with parent-document provenance."""
POLICY = 'token-windows-v1'


def split_document(title, body, tokenizer, max_tokens):
    text = title + '\n' + body
    if len(tokenizer.encode(text, add_special_tokens=True, verbose=False)) <= max_tokens:
        return [text]
    title_encoding = tokenizer(title, add_special_tokens=False, return_offsets_mapping=True, verbose=False)
    # Keep space for the body even for an unusually long OCR heading.
    title_budget = max_tokens // 3
    if len(title_encoding['input_ids']) > title_budget:
        title = title[:title_encoding['offset_mapping'][title_budget - 1][1]]
    prefix = title + '\n'
    budget = max_tokens - len(tokenizer.encode(prefix, add_special_tokens=True, verbose=False)) - 4
    if budget <= 0:
        raise ValueError('Embedding token limit is too small for a passage')
    encoded = tokenizer(body, add_special_tokens=False, return_offsets_mapping=True, verbose=False)
    offsets = encoded['offset_mapping']
    passages, start = [], 0
    while start < len(offsets):
        end = min(start + budget, len(offsets))
        passage = prefix + body[offsets[start][0]:offsets[end - 1][1]]
        while len(tokenizer.encode(passage, add_special_tokens=True, verbose=False)) > max_tokens:
            end -= 1
            if end <= start:
                raise ValueError('A token cannot fit into the embedding passage')
            passage = prefix + body[offsets[start][0]:offsets[end - 1][1]]
        passages.append(passage)
        if end == len(offsets):
            break
        start = max(start + 1, end - min(40, budget // 5))
    return passages or [prefix]


def prepare(docs, tokenizer, max_tokens):
    texts, parents, split_count = [], [], 0
    for index, doc in enumerate(docs):
        passages = split_document(doc['title'], doc['text'], tokenizer, max_tokens)
        split_count += len(passages) > 1
        texts.extend(passages)
        parents.extend([index] * len(passages))
    return texts, parents, split_count
