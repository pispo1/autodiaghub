require 'fileutils'
require 'json'
require 'yaml'

root, revision = ARGV
abort 'Usage: ruby scripts/build-psa-catalog.rb PSA_RE_CHECKOUT COMMIT_SHA' unless
  root && revision&.match?(/\A[0-9a-f]{40}\z/)

def english(value)
  value.is_a?(Hash) ? value['en'] : value
end

def load_yaml(path)
  YAML.safe_load(File.read(path), aliases: true)
end

def fields_for(data)
  return [] unless data['params'].is_a?(Hash)

  data['params'].map do |name, param|
    next unless param.is_a?(Hash) && param['bits'].is_a?(String)

    field = {
      name: english(param['display_name']) || name.tr('_', ' ').capitalize,
      bits: param['bits'], type: param['type']
    }
    %w[factor offset].each { |key| field[key] = param[key] if param[key].is_a?(Numeric) }
    field[:unit] = param['units'] if param['units'].is_a?(String)
    if param['values'].is_a?(Hash)
      values = param['values'].map do |value, label|
        [value, english(label)] if value.is_a?(Integer) && english(label).is_a?(String)
      end.compact.to_h
      field[:values] = values unless values.empty?
    end
    field
  end.compact
end

def model_for(directory, addresses)
  definition = load_yaml(File.join(directory, 'ecu.yml'))
  services = definition.fetch('services', [])
  probe = definition.dig('identification', 'request').to_s.delete(' ').upcase
  target = definition.fetch('addressing', []).find do |address|
    expected = address['protocol'] == 'UDS' ? /\A22[0-9A-F]{4}\z/ : /\A21[0-9A-F]{2}\z/
    %w[UDS KWP-PSA2000 KWP2000].include?(address['protocol']) &&
      address['transport'] == 'can-tp' && !address['bus'] &&
      [address['request_id'], address['response_id']] == addresses &&
      probe.match?(expected) && probe != '22F190' && services.include?(probe[0, 2].to_i(16))
  end
  return unless target

  protocol = target['protocol']
  uds = protocol == 'UDS'
  field_path, id_key, prefix = uds ? %w[dids did 22] : %w[lids lid 21]
  parameters = Dir.glob(File.join(directory, field_path, '*.yml')).sort.map do |path|
    entry = load_yaml(path)
    id = entry[id_key]
    next unless id.is_a?(Integer) && id.between?(0, uds ? 0xffff : 0xff) &&
      entry['access'] == 'read' && %w[live identification].include?(entry['kind'])
    next unless services.include?(prefix.to_i(16))

    length = entry['length']
    {
      id: format(uds ? '%04X' : '%02X', id),
      name: english(entry['display_name']) || entry['name'],
      kind: entry['kind'], length: length.is_a?(Integer) && length.positive? ? length : nil,
      fields: fields_for(entry)
    }
  end.compact
  parameters.sort_by! { |parameter| [parameter[:kind] == 'live' ? 0 : 1, parameter[:name].to_s] }
  dtcs_file = File.join(directory, 'dtcs.yml')
  descriptions = if File.file?(dtcs_file)
    load_yaml(dtcs_file).map do |code, item|
      next unless code.is_a?(String) && code.match?(/\A[PCBU][0-3][0-9A-F]{3}\z/) && item.is_a?(Hash)

      description = english(item['display_name'])
      [code, description] if description.is_a?(String)
    end.compact.to_h
  else
    {}
  end
  read_dtcs = uds ? services.include?(0x19) : protocol == 'KWP-PSA2000' && services.include?(0x17)
  {
    protocol: protocol, requestId: format('%03X', addresses[0]),
    responseId: format('%03X', addresses[1]), probe: probe,
    parameters: parameters, readDtcs: read_dtcs,
    clearDtcs: read_dtcs && services.include?(0x14), dtcs: descriptions
  }
end

def architecture_chain(architectures, architecture)
  family, variant = architecture.split('.')
  chain = []
  while variant
    chain << "#{family}.#{variant}"
    variant = architectures.fetch(family).fetch(variant)['parent']
  end
  chain
end

def resolve_model(root, chain, node, name)
  path = chain.map { |arch| "diag/#{arch}/#{node}/#{name}" }.find do |candidate|
    File.file?(File.join(root, candidate, 'ecu.yml'))
  end
  return path if path

  family = chain.first.split('.').first
  siblings = Dir.glob(File.join(root, 'diag', "#{family}.*", node, name, 'ecu.yml'))
  # Use a unique sibling record only for an explicitly listed model.
  File.dirname(siblings.first).delete_prefix(File.join(root, '')) if siblings.length == 1
end

def build_variant(root, architectures, models, version, id, label, scan_enabled)
  architecture = version.fetch('architecture')
  chain = architecture_chain(architectures, architecture)
  if scan_enabled
    bus = chain.lazy.map do |entry|
      architectures.dig(*entry.split('.'), 'networks', 'HS', 'IS')
    end.find(&:itself)
    abort "Unexpected CAN bus for #{architecture}" unless bus&.values_at('protocol', 'bitrate') == ['CAN', 500]
  end

  nodes = chain.reverse_each.each_with_object({}) do |entry, merged|
    path = File.join(root, 'nodes', "#{entry}.yml")
    merged.merge!(load_yaml(path)) if File.file?(path)
  end
  network_nodes = version.fetch('nodes', {})
  model_names_by_node = version.fetch('ecu_models', {})
  node_ids = network_nodes.values.flatten.uniq
  node_ids |= model_names_by_node.keys unless scan_enabled
  ecus = node_ids.map do |node|
    details = nodes.fetch(node, {})
    addresses = details.fetch('diag', {}).values_at('request_id', 'response_id')
    model_names = model_names_by_node.fetch(node, [])
    routes = model_names.map do |name|
      next unless scan_enabled && addresses.all? { |address| address.is_a?(Integer) && address.between?(0x100, 0x7ff) }

      path = resolve_model(root, chain, node, name)
      next unless path

      models[path] ||= model_for(File.join(root, path), addresses)
      { name: name, key: path } if models[path]
    end.compact
    {
      id: node, name: english(details['name']) || node,
      networks: network_nodes.keys.select { |network| network_nodes[network].include?(node) },
      optional: version.fetch('optional_nodes', []).include?(node),
      modelNames: model_names, models: routes
    }
  end
  {
    id: id, label: label, architecture: architecture, years: version['years'],
    scanAvailable: ecus.any? { |ecu| !ecu[:models].empty? }, ecus: ecus
  }
end

BRAND_NAMES = {
  'citroen' => 'Citroën', 'ds' => 'DS', 'peugeot' => 'Peugeot', 'opel' => 'Opel',
  'vauxhall' => 'Vauxhall', 'fiat' => 'Fiat', 'toyota' => 'Toyota', 'mitsubishi' => 'Mitsubishi',
  'dongfeng' => 'Dongfeng', 'lancia' => 'Lancia', 'naza' => 'Naza'
}.freeze

def display_vehicle(name)
  brand, model = name.split(' ', 2)
  [BRAND_NAMES.fetch(brand.downcase, brand), model].compact.join(' ')
end

def display_variant(id)
  return 'All versions' if id == 'all'

  id.tr('_', ' ').sub(/phase(?=\d)/, 'phase ').capitalize
end

architectures = load_yaml(File.join(root, 'architectures.yml'))
models = {}
scan_profiles = {
  'B5' => ['B58', 'Citroën C4 Picasso I / Grand C4 Picasso', { 'picasso' => 'Picasso' }],
  'B78' => ['B78', 'Citroën C4 Picasso II / Grand Picasso / SpaceTourer',
            { 'phase1' => 'Phase 1', 'phase1_eco' => 'Phase 1 (Eco, provisional in PSA-RE)', 'phase2' => 'Phase 2' }]
}
vehicles = Dir.glob(File.join(root, 'cars', '*.yml')).sort.flat_map do |file|
  project = File.basename(file, '.yml')
  source = "cars/#{project}.yml"
  car = load_yaml(file)
  codes = car.fetch('codes')
  variants = car.fetch('versions').dup
  entries = []
  if scan_profiles.key?(project)
    code, name, scan_variants = scan_profiles.fetch(project)
    aliases = project == 'B5' ? { code => codes.fetch(code) } : codes
    entries << {
      code: code, name: name, aliases: aliases.values.flatten.map { |alias_name| display_vehicle(alias_name) }.uniq,
      projectCodes: aliases.keys, source: source,
      variants: scan_variants.map do |id, label|
        build_variant(root, architectures, models, variants.delete(id), id, label, true)
      end
    }
    codes = codes.reject { |key, _| key == code } if project == 'B5'
  end
  unless variants.empty?
    names = codes.values.flatten.map { |name| display_vehicle(name) }.uniq
    entries << {
      code: project, name: names.first, aliases: names, projectCodes: codes.keys, source: source,
      variants: variants.map do |id, version|
        build_variant(root, architectures, models, version, id, display_variant(id), false)
      end
    }
  end
  entries
end.sort_by { |vehicle| [vehicle[:name].downcase, vehicle[:code]] }

models.compact!
output = File.expand_path('../dist/psa', __dir__)
File.write(File.join(output, 'catalog.json'), JSON.generate({ revision: revision, vehicles: vehicles, models: models }) + "\n")
FileUtils.cp(File.join(root, 'LICENCE'), File.join(output, 'LICENSE.txt'))
warn "Bundled #{vehicles.size} vehicle groups, #{vehicles.sum { |vehicle| vehicle[:variants].length }} variants, and #{models.size} diagnostic definitions."
