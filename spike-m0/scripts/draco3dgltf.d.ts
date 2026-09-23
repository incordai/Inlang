/**
 * The two entry points of the Draco glTF encoder build that make-model.ts uses.
 * The package ships no type declarations; this states only what is called.
 */
declare module 'draco3dgltf' {
  const draco3d: {
    createEncoderModule(options?: object): Promise<unknown>;
    createDecoderModule(options?: object): Promise<unknown>;
  };
  export default draco3d;
}
