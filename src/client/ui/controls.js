export function attachControls({ appState, systems, uniforms, rebuildPlane, stateAccessors = {} }) {
  const exagEl = document.getElementById('exag');
  exagEl.oninput = () => {
    appState.set('exag', Number(exagEl.value));
  };

  appState.subscribe(({ name, value }) => {
    if (name === 'exag') {
      stateAccessors.setExag?.(value);
      document.getElementById('exagv').textContent = value.toFixed(2);
      uniforms.overlayUniforms.uExag.value = value;
      uniforms.buildingUniforms.uExag.value = value;
      uniforms.treeUniforms.uExag.value = value;
      uniforms.canopyUniforms.uExag.value = value;
      uniforms.waterUniforms.uExag.value = value;
      uniforms.amenityAreaUniforms.uExag.value = value;
      uniforms.amenityPropUniforms.uExag.value = value;
      systems.roads.setExaggeration(value);
      systems.buildings.setExaggeration(value);
      systems.forest.setExaggeration(value);
      systems.water.setExaggeration(value);
      systems.amenities.setExaggeration(value);
    }
  });

  const sseEl = document.getElementById('sse');
  sseEl.oninput = () => {
    const value = Number(sseEl.value);
    stateAccessors.setSsePx?.(value);
    document.getElementById('ssev').textContent = value.toFixed(1);
  };

  const segEl = document.getElementById('seg');
  segEl.oninput = () => {
    const value = Number(segEl.value);
    rebuildPlane(value);
    document.getElementById('segv').textContent = String(stateAccessors.getSegments?.() ?? value);
  };

  document.getElementById('showRoads').onchange = (event) => {
    systems.roads.setRoadsVisible(event.target.checked);
  };
  document.getElementById('showTowns').onchange = (event) => {
    systems.roads.setTownsVisible(event.target.checked);
  };
  document.getElementById('showBld').onchange = (event) => {
    systems.buildings.setVisible(event.target.checked);
    systems.amenities.setVisible(event.target.checked);
  };
  document.getElementById('showTrees').onchange = (event) => {
    systems.forest.setVisible(event.target.checked);
    systems.forest.updateForGeology({
      bedrockVisible: Boolean(uniforms.geoUniforms.uBedShow.value),
      quaternaryVisible: Boolean(uniforms.geoUniforms.uQuatShow.value),
    });
  };

  const drapeEl = document.getElementById('drape');
  drapeEl.oninput = () => {
    systems.roads.setDrapeOffset(Number(drapeEl.value));
    document.getElementById('drapev').textContent = drapeEl.value;
  };

  const bldRangeEl = document.getElementById('bldRange');
  bldRangeEl.oninput = () => {
    const rangeMetres = Number(bldRangeEl.value) * 1000;
    stateAccessors.setBuildingRange?.(rangeMetres);
    document.getElementById('bldRangev').textContent = bldRangeEl.value;
    systems.buildings.setRange(rangeMetres);
    uniforms.amenityAreaUniforms.uFadeFar.value = rangeMetres;
    uniforms.amenityAreaUniforms.uFadeNear.value = Math.max(rangeMetres - 4000, rangeMetres * 0.7);
  };

  const canopyRangeEl = document.getElementById('canopyRange');
  canopyRangeEl.oninput = () => {
    const rangeMetres = Number(canopyRangeEl.value) * 1000;
    stateAccessors.setCanopyRange?.(rangeMetres);
    document.getElementById('canopyRangev').textContent = canopyRangeEl.value;
    systems.forest.setRange(rangeMetres);
  };

  const canopyLodEl = document.getElementById('canopyLod');
  canopyLodEl.oninput = () => {
    const mid = Number(canopyLodEl.value) * 1000;
    const lodLo = Math.max(50, mid - 300);
    const lodHi = mid + 300;
    stateAccessors.setCanopyLod?.(lodLo, lodHi);
    document.getElementById('canopyLodv').textContent = canopyLodEl.value;
    systems.forest.setLodSwitch(lodLo, lodHi);
  };

  function updateForestVsGeology() {
    systems.forest.updateForGeology({
      bedrockVisible: Boolean(uniforms.geoUniforms.uBedShow.value),
      quaternaryVisible: Boolean(uniforms.geoUniforms.uQuatShow.value),
    });
  }

  document.getElementById('cb-bedrock').addEventListener('change', (event) => {
    systems.geology.setBedrockVisible(event.target.checked);
    updateForestVsGeology();
  });
  document.getElementById('cb-quat').addEventListener('change', (event) => {
    systems.geology.setQuaternaryVisible(event.target.checked);
    updateForestVsGeology();
  });
  document.getElementById('cb-faults').addEventListener('change', (event) => {
    systems.faults.setVisible(event.target.checked);
  });

  const blendInput = document.getElementById('r-geo-blend');
  const blendVal = document.getElementById('r-geo-blend-val');
  blendInput.addEventListener('input', (event) => {
    const value = parseFloat(event.target.value);
    systems.geology.setOpacity(value);
    blendVal.textContent = value.toFixed(2);
  });

  document.getElementById('cb-contours').addEventListener('change', (event) => {
    uniforms.contourUniforms.uContourShow.value = event.target.checked ? 1.0 : 0.0;
  });
  document.getElementById('contour-interval').addEventListener('change', (event) => {
    uniforms.contourUniforms.uContourInterval.value = parseFloat(event.target.value);
  });

  const contourOpEl = document.getElementById('r-contour-opacity');
  const contourOpVal = document.getElementById('r-contour-opacity-val');
  contourOpEl.addEventListener('input', (event) => {
    const value = parseFloat(event.target.value);
    uniforms.contourUniforms.uContourOpacity.value = value;
    contourOpVal.textContent = value.toFixed(2);
  });
}
