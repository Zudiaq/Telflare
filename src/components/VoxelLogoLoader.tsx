import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';

const PLAY_SPEED = 4.5;

export const VoxelLogoLoader: React.FC = () => {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let frameId = 0;
    let disposed = false;
    let logoGroup: THREE.Group | null = null;
    let renderer: THREE.WebGLRenderer | null = null;
    let camera: THREE.PerspectiveCamera | null = null;
    let scene: THREE.Scene | null = null;

    const width = Math.max(mount.clientWidth, 1);
    const height = Math.max(mount.clientHeight, 1);
    scene = new THREE.Scene();
    
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.95);
    scene.add(ambientLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.55);
    dirLight.position.set(20, 25, 30);
    scene.add(dirLight);
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.25);
    fillLight.position.set(-20, -15, 20);
    scene.add(fillLight);

    camera = new THREE.PerspectiveCamera(34, width / height, 0.1, 1000);
    camera.position.set(0, 0, 145);

    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
    } catch {
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const buildLogo = async () => {
      const loader = new SVGLoader();
      
      loader.load('/cloud.svg', (data) => {
        if (disposed || !scene) return;
        
        logoGroup = new THREE.Group();
        const paths = data.paths;
        
        for (let i = 0; i < paths.length; i++) {
          const path = paths[i];
          const hex = path.color.getHexString().toLowerCase();
          
          let materialColor: THREE.Color;
          
          if (hex === '931c24' || (path.color.r > 0.4 && path.color.r > path.color.g * 1.4)) {
            materialColor = new THREE.Color(0xb02432);
          }
          else if (hex === '525b66' || (path.color.b > path.color.r && path.color.b >= path.color.g)) {
            materialColor = new THREE.Color(0x52718e);
          }
          else {
            materialColor = new THREE.Color(0x5b616c);
          }

          const material = new THREE.MeshStandardMaterial({
            color: materialColor,
            side: THREE.DoubleSide,
            roughness: 0.4,
            metalness: 0.05,
          });

          const shapes = SVGLoader.createShapes(path);

          for (let j = 0; j < shapes.length; j++) {
            const shape = shapes[j];
            const geometry = new THREE.ExtrudeGeometry(shape, {
              depth: 250,
              bevelEnabled: false,
            });
            const mesh = new THREE.Mesh(geometry, material);
            logoGroup.add(mesh);
          }
        }
        
        logoGroup.scale.y = -1;
        logoGroup.updateMatrixWorld(true);
        
        const box = new THREE.Box3().setFromObject(logoGroup);
        const center = box.getCenter(new THREE.Vector3());
        logoGroup.position.x = -center.x;
        logoGroup.position.y = -center.y;
        logoGroup.position.z = -center.z;
        
        const wrapper = new THREE.Group();
        wrapper.add(logoGroup);
        
        wrapper.scale.set(0.028, 0.028, 0.028);
        
        scene.add(wrapper);
        logoGroup = wrapper;
      });
    };

    buildLogo();

    const resizeObserver = new ResizeObserver(() => {
      if (!mount || !renderer || !camera) return;
      const nextWidth = Math.max(mount.clientWidth, 1);
      const nextHeight = Math.max(mount.clientHeight, 1);
      camera.aspect = nextWidth / nextHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(nextWidth, nextHeight);
    });
    resizeObserver.observe(mount);

    const animate = () => {
      frameId = requestAnimationFrame(animate);
      if (!renderer || !scene || !camera || !logoGroup) return;
      logoGroup.rotation.y += 0.004 * PLAY_SPEED;
      renderer.render(scene, camera);
    };
    frameId = requestAnimationFrame(animate);

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      logoGroup?.traverse((child: any) => {
        if (child.isMesh) {
          child.geometry.dispose();
          child.material.dispose();
        }
      });
      renderer?.dispose();
      renderer?.domElement.remove();
    };
  }, []);

  return <div ref={mountRef} className="voxel-logo-loader -mb-6" aria-hidden="true" />;
};
